// Integration tests for the nightly pipeline orchestration (src/nightly/pipeline.ts).
//
// Mocking strategy:
// - '../nightly/reflection' is mocked directly (not the real reflection.ts + a mocked mistral_api) so
//   these tests assert pipeline.ts's ORCHESTRATION logic, not reflection.ts's prompt wording.
// - '../database/models/memory_archive.model' is backed by a small in-memory fake (MemoryArchiveFake)
//   that mirrors the real module's hash-based no-churn versioning, so multi-call interactions (the
//   journal loop reading back what it just wrote, phase 4's review + archive, phase 5/6 reconcile) are
//   genuinely exercised rather than hand-chained with mockResolvedValueOnce.
// - '../database/models/nightly_job.model' and '../database/models/context.model' are coarse per-call
//   jest.fn mocks -- their own real behavior is covered by dedicated model unit tests already.
// - '../nightly/tools' is the REAL module -- it is simple in-process state that pipeline.ts genuinely
//   depends on, and using the real module makes the phase-3/4 staged-update flow realistic.

import { createHash } from 'node:crypto';

jest.mock('../config', () => ({
  config: {
    mistral: {
      agentId: 'family-agent-1',
      nightlyAgentId: 'nightly-agent-1'
    },
    nightly: {
      lockStaleMs: 2 * 60 * 60 * 1000,
      maxIterations: 15,
      archiveKeepVersions: 10,
      eagerMaxChars: 2000
    }
  }
}));

jest.mock('../database/models/nightly_job.model', () => ({
  createJobLog: jest.fn(),
  updateJobLog: jest.fn(),
  getWatermark: jest.fn(),
  pruneOldJobLogs: jest.fn(),
  acquireLock: jest.fn(),
  releaseLock: jest.fn(),
  findRunningJob: jest.fn()
}));

jest.mock('../database/models/memory_archive.model', () => ({
  getCurrentVersion: jest.fn(),
  insertNextVersion: jest.fn(),
  listCurrentVersions: jest.fn(),
  listUnsynced: jest.fn(),
  markSynced: jest.fn(),
  pruneOldVersions: jest.fn()
}));

jest.mock('../database/models/context.model', () => ({
  upsertContextEntry: jest.fn()
}));

jest.mock('../nightly/reflection', () => ({
  buildTranscript: jest.fn(),
  runJournal: jest.fn(),
  runIntegrate: jest.fn(),
  runReview: jest.fn(),
  runCompact: jest.fn()
}));

jest.mock('../mistral/mistral_api', () => ({
  listConversations: jest.fn(),
  getConversationMessages: jest.fn(),
  deleteConversation: jest.fn(),
  listDocuments: jest.fn(),
  replaceDocument: jest.fn(),
  deleteDocument: jest.fn(),
  uploadDocument: jest.fn(),
  askAgent: jest.fn(),
  runAgentToolLoop: jest.fn(),
  getTextContent: jest.fn()
}));

import { LockHeldError, runNightlyPipeline } from '../nightly/pipeline';
import { resetNightlyToolsState } from '../nightly/tools';
import {
  NightlyJobLog,
  acquireLock,
  createJobLog,
  findRunningJob,
  getWatermark,
  pruneOldJobLogs,
  releaseLock,
  updateJobLog
} from '../database/models/nightly_job.model';
import {
  getCurrentVersion,
  insertNextVersion,
  listCurrentVersions,
  listUnsynced,
  markSynced,
  pruneOldVersions
} from '../database/models/memory_archive.model';
import { upsertContextEntry } from '../database/models/context.model';
import { buildTranscript, runCompact, runIntegrate, runJournal, runReview } from '../nightly/reflection';
import {
  deleteConversation,
  deleteDocument,
  getConversationMessages,
  listConversations,
  listDocuments,
  replaceDocument
} from '../mistral/mistral_api';

const FAMILY_AGENT_ID = 'family-agent-1';

const mockCreateJobLog = createJobLog as jest.Mock;
const mockUpdateJobLog = updateJobLog as jest.Mock;
const mockGetWatermark = getWatermark as jest.Mock;
const mockPruneOldJobLogs = pruneOldJobLogs as jest.Mock;
const mockAcquireLock = acquireLock as jest.Mock;
const mockReleaseLock = releaseLock as jest.Mock;
const mockFindRunningJob = findRunningJob as jest.Mock;

const mockGetCurrentVersion = getCurrentVersion as jest.Mock;
const mockInsertNextVersion = insertNextVersion as jest.Mock;
const mockListCurrentVersions = listCurrentVersions as jest.Mock;
const mockListUnsynced = listUnsynced as jest.Mock;
const mockMarkSynced = markSynced as jest.Mock;
const mockPruneOldVersions = pruneOldVersions as jest.Mock;

const mockUpsertContextEntry = upsertContextEntry as jest.Mock;

const mockBuildTranscript = buildTranscript as jest.Mock;
const mockRunJournal = runJournal as jest.Mock;
const mockRunIntegrate = runIntegrate as jest.Mock;
const mockRunReview = runReview as jest.Mock;
const mockRunCompact = runCompact as jest.Mock;

const mockListConversations = listConversations as jest.Mock;
const mockGetConversationMessages = getConversationMessages as jest.Mock;
const mockDeleteConversation = deleteConversation as jest.Mock;
const mockListDocuments = listDocuments as jest.Mock;
const mockReplaceDocument = replaceDocument as jest.Mock;
const mockDeleteDocument = deleteDocument as jest.Mock;

// ---------------------------------------------------------------------------
// In-memory fake for memory_archive.model, mirroring its real hash-based no-churn versioning
// ---------------------------------------------------------------------------

interface FakeArchiveRow {
  id: number;
  filePath: string;
  content: string;
  contentHash: string;
  version: number;
  mistralDocId: string | null;
  syncedAt: Date | null;
  createdAt: Date;
}

function hashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

class MemoryArchiveFake {
  private rows: FakeArchiveRow[] = [];
  private nextId = 1;

  private currentFor(filePath: string): FakeArchiveRow | null {
    const matches = this.rows.filter(r => r.filePath === filePath);
    if (matches.length === 0) {
      return null;
    }
    return matches.reduce((a, b) => (b.version > a.version ? b : a));
  }

  private currentAll(): FakeArchiveRow[] {
    const byPath = new Map<string, FakeArchiveRow>();
    for (const row of this.rows) {
      const existing = byPath.get(row.filePath);
      if (!existing || row.version > existing.version) {
        byPath.set(row.filePath, row);
      }
    }
    return [...byPath.values()];
  }

  /** Test helper: seeds a pre-existing current version directly, bypassing the mocked entry point */
  async seed(filePath: string, content: string): Promise<FakeArchiveRow> {
    const { row } = await this.insertNextVersion(filePath, content);
    return row;
  }

  getCurrentVersion = async (filePath: string): Promise<FakeArchiveRow | null> => this.currentFor(filePath);

  insertNextVersion = async (
    filePath: string,
    content: string
  ): Promise<{ row: FakeArchiveRow; created: boolean }> => {
    const contentHash = hashOf(content);
    const current = this.currentFor(filePath);

    if (current && current.contentHash === contentHash) {
      return { row: current, created: false };
    }

    const row: FakeArchiveRow = {
      id: this.nextId++,
      filePath,
      content,
      contentHash,
      version: current ? current.version + 1 : 1,
      mistralDocId: null,
      syncedAt: null,
      createdAt: new Date()
    };
    this.rows.push(row);
    return { row, created: true };
  };

  listCurrentVersions = async (): Promise<FakeArchiveRow[]> => this.currentAll();

  listUnsynced = async (): Promise<FakeArchiveRow[]> => this.currentAll().filter(r => r.syncedAt === null);

  markSynced = async (id: number, mistralDocId: string): Promise<void> => {
    const row = this.rows.find(r => r.id === id);
    if (row) {
      row.mistralDocId = mistralDocId;
      row.syncedAt = new Date();
    }
  };

  pruneOldVersions = async (): Promise<number> => 0;
}

let archive: MemoryArchiveFake;

function conversation(id: string, name: string, agentId: string = FAMILY_AGENT_ID) {
  return { id, name, agentId, updatedAt: '2026-07-05T20:00:00Z' };
}

describe('nightly pipeline integration', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    resetNightlyToolsState();

    archive = new MemoryArchiveFake();
    mockGetCurrentVersion.mockImplementation(archive.getCurrentVersion);
    mockInsertNextVersion.mockImplementation(archive.insertNextVersion);
    mockListCurrentVersions.mockImplementation(archive.listCurrentVersions);
    mockListUnsynced.mockImplementation(archive.listUnsynced);
    mockMarkSynced.mockImplementation(archive.markSynced);
    mockPruneOldVersions.mockImplementation(archive.pruneOldVersions);

    mockFindRunningJob.mockResolvedValue(null);
    mockCreateJobLog.mockResolvedValue(1);
    mockUpdateJobLog.mockResolvedValue(undefined);
    mockGetWatermark.mockResolvedValue(null);
    mockPruneOldJobLogs.mockResolvedValue(0);
    mockAcquireLock.mockResolvedValue(true);
    mockReleaseLock.mockResolvedValue(undefined);

    mockUpsertContextEntry.mockResolvedValue('updated');

    mockListConversations.mockResolvedValue([]);
    mockGetConversationMessages.mockResolvedValue([]);
    mockDeleteConversation.mockResolvedValue(undefined);
    mockListDocuments.mockResolvedValue([]);
    mockReplaceDocument.mockResolvedValue({ id: 'doc-default', path: 'default' });
    mockDeleteDocument.mockResolvedValue(undefined);

    mockBuildTranscript.mockReturnValue('transcript');
    mockRunJournal.mockResolvedValue('journal text');
    mockRunIntegrate.mockResolvedValue({ finalText: '', iterations: 0 });
    mockRunReview.mockResolvedValue({ approved: true, reason: '' });
    mockRunCompact.mockResolvedValue('compacted');
  });

  // -------------------------------------------------------------------------
  // 1. Happy path
  // -------------------------------------------------------------------------
  it('happy path: archives journals + a staged file, regenerates context, deletes conversations', async () => {
    mockListConversations.mockResolvedValueOnce([
      conversation('conv-1', 'Alice'),
      conversation('conv-2', 'Bob'),
      conversation('conv-3', 'Carol')
    ]);
    mockRunJournal.mockImplementation(async (userName: string) => 'Journal about ' + userName);

    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      await executeTool('stage_update', {
        path: 'people/alice.md',
        content: 'Alice profile content',
        isNew: true
      });
      return { finalText: 'staged 1 file', iterations: 1 };
    });
    mockRunReview.mockResolvedValue({ approved: true, reason: 'looks good' });
    mockRunCompact.mockResolvedValue('compacted profile');
    mockUpsertContextEntry.mockResolvedValue('inserted');

    const result = await runNightlyPipeline();

    expect(result.status).toBe('completed');
    expect(result.conversationsProcessed).toBe(3);

    expect(mockInsertNextVersion).toHaveBeenCalledWith('journals/alice/conv-1.md', 'Journal about Alice');
    expect(mockInsertNextVersion).toHaveBeenCalledWith('journals/bob/conv-2.md', 'Journal about Bob');
    expect(mockInsertNextVersion).toHaveBeenCalledWith('journals/carol/conv-3.md', 'Journal about Carol');
    expect(mockInsertNextVersion).toHaveBeenCalledWith('people/alice.md', 'Alice profile content');

    expect(mockUpsertContextEntry).toHaveBeenCalledWith('Profile of Alice', 'compacted profile');

    expect(mockDeleteConversation).toHaveBeenCalledTimes(3);
    expect(mockDeleteConversation).toHaveBeenCalledWith('conv-1');
    expect(mockDeleteConversation).toHaveBeenCalledWith('conv-2');
    expect(mockDeleteConversation).toHaveBeenCalledWith('conv-3');

    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 2. Change detection (no-churn)
  // -------------------------------------------------------------------------
  it('change detection: an identical staged update is a no-op, not an error or a counted change', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    const seeded = await archive.seed('people/alice.md', 'Existing alice content');
    // Mark the seeded row as already synced -- otherwise Phase 5 would re-upload it regardless of
    // whether Phase 4 detected a content change, and this test couldn't tell the two apart.
    await archive.markSynced(seeded.id, 'doc-existing-alice');

    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      await executeTool('stage_update', {
        path: 'people/alice.md',
        content: 'Existing alice content',
        isNew: false
      });
      return { finalText: 'no changes needed', iterations: 1 };
    });
    mockRunReview.mockResolvedValue({ approved: true, reason: 'unchanged, fine as-is' });

    const result = await runNightlyPipeline();

    expect(mockInsertNextVersion).toHaveBeenCalledWith('people/alice.md', 'Existing alice content');

    const archivePhaseUpdate = mockUpdateJobLog.mock.calls.find(
      call => call[1] && call[1].lastCompletedPhase === '4-archive'
    );
    expect(archivePhaseUpdate).toBeDefined();
    expect(archivePhaseUpdate![1].filesUpdated).toBe(0);
    expect(archivePhaseUpdate![1].filesCreated).toBe(0);

    // Identical content ⇒ no new version ⇒ the already-synced row stays synced ⇒ no upload call for
    // it specifically (the run's own new journal for conv-1 is separately and correctly uploaded).
    expect(mockReplaceDocument.mock.calls.some(call => call[0] === 'people/alice.md')).toBe(false);

    // Not treated as an error: the update was approved, just a no-op.
    expect(result.status).toBe('completed');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 3. Reviewer rejects one file
  // -------------------------------------------------------------------------
  it('reviewer rejects one staged file: the other proceeds, run reaches phase 7 as partial', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);

    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      await executeTool('stage_update', {
        path: 'people/alice.md',
        content: 'Alice new profile',
        isNew: true
      });
      await executeTool('stage_update', { path: 'people/bob.md', content: 'Bob new profile', isNew: true });
      return { finalText: 'staged 2 files', iterations: 1 };
    });
    mockRunReview.mockImplementation(async (update: any) => {
      if (update.path === 'people/bob.md') {
        return { approved: false, reason: 'hallucinated, rejecting' };
      }
      return { approved: true, reason: 'looks solid' };
    });

    const result = await runNightlyPipeline();

    expect(mockInsertNextVersion).toHaveBeenCalledWith('people/alice.md', 'Alice new profile');
    expect(mockInsertNextVersion.mock.calls.some(call => call[0] === 'people/bob.md')).toBe(false);

    expect(result.status).toBe('partial');
    // The run must still have reached and completed phase 7 (cleanup), not aborted early.
    expect(mockDeleteConversation).toHaveBeenCalledWith('conv-1');
    expect(mockPruneOldVersions).toHaveBeenCalled();
    expect(mockPruneOldJobLogs).toHaveBeenCalled();

    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 4. Resume
  // -------------------------------------------------------------------------
  it('resume: reuses the orphaned job id and its conversation id list verbatim', async () => {
    const orphan: NightlyJobLog = {
      id: 77,
      startedAt: new Date('2026-07-05T22:00:00Z'),
      completedAt: null,
      status: 'running',
      lastCompletedPhase: '2-journal',
      processedConversationIds: ['conv-9', 'conv-10'],
      skippedConversationIds: [],
      retryCount: 0,
      errorMessage: null,
      conversationsProcessed: 0,
      filesUpdated: 0,
      filesCreated: 0
    };
    mockFindRunningJob.mockResolvedValueOnce(orphan);
    // Deliberately returns a conversation set that shares NO ids with the orphan, so any assertion
    // that the processed id set matches this listing (rather than the orphan row) would fail --
    // proving the id list itself is reused verbatim and not re-derived from this call.
    mockListConversations.mockResolvedValueOnce([conversation('conv-999', 'Someone Else')]);

    const result = await runNightlyPipeline();

    expect(mockCreateJobLog).not.toHaveBeenCalled();
    expect(result.jobId).toBe(77);

    expect(mockInsertNextVersion).toHaveBeenCalledWith('journals/conv-9/conv-9.md', 'journal text');
    expect(mockInsertNextVersion).toHaveBeenCalledWith('journals/conv-10/conv-10.md', 'journal text');
    expect(mockDeleteConversation).toHaveBeenCalledWith('conv-9');
    expect(mockDeleteConversation).toHaveBeenCalledWith('conv-10');
    expect(mockDeleteConversation).not.toHaveBeenCalledWith('conv-999');

    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('resume: does not re-journal (or re-fetch messages for) a conversation already journaled before the crash', async () => {
    const orphan: NightlyJobLog = {
      id: 77,
      startedAt: new Date('2026-07-05T22:00:00Z'),
      completedAt: null,
      status: 'running',
      lastCompletedPhase: '2-journal',
      processedConversationIds: ['conv-9', 'conv-10'],
      skippedConversationIds: [],
      retryCount: 0,
      errorMessage: null,
      conversationsProcessed: 0,
      filesUpdated: 0,
      filesCreated: 0
    };
    mockFindRunningJob.mockResolvedValueOnce(orphan);
    mockListConversations.mockResolvedValueOnce([conversation('conv-999', 'Someone Else')]);
    // conv-9's journal was already written and archived in the crashed run, BEFORE it died -- this is
    // the state that Phase 2's `if (!existing)` anti-duplication guard is supposed to detect and skip.
    await archive.seed('journals/conv-9/conv-9.md', 'Already-written journal for conv-9');

    await runNightlyPipeline();

    // conv-9: already journaled -- must be skipped entirely, not just re-inserted with the same content.
    expect(mockGetConversationMessages).not.toHaveBeenCalledWith('conv-9');
    expect(mockRunJournal).not.toHaveBeenCalledWith('conv-9', expect.anything());
    expect(mockInsertNextVersion.mock.calls.some(call => call[0] === 'journals/conv-9/conv-9.md')).toBe(
      false
    );

    // conv-10: not yet journaled -- must still be journaled fresh this run.
    expect(mockGetConversationMessages).toHaveBeenCalledWith('conv-10');
    expect(mockInsertNextVersion).toHaveBeenCalledWith('journals/conv-10/conv-10.md', 'journal text');

    // Both conversations are still cleaned up in Phase 7 regardless of which path journaled them.
    expect(mockDeleteConversation).toHaveBeenCalledWith('conv-9');
    expect(mockDeleteConversation).toHaveBeenCalledWith('conv-10');

    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 5. Skipped conversation
  // -------------------------------------------------------------------------
  it('skipped conversation: a failed journal step is logged as skipped, excluded from cleanup', async () => {
    mockListConversations.mockResolvedValueOnce([
      conversation('conv-1', 'Alice'),
      conversation('conv-2', 'Bob')
    ]);
    mockGetConversationMessages.mockImplementation(async (id: string) => {
      if (id === 'conv-2') {
        throw new Error('boom: failed to fetch messages');
      }
      return [];
    });

    const result = await runNightlyPipeline();

    const skippedUpdate = mockUpdateJobLog.mock.calls.find(
      call => call[1] && call[1].skippedConversationIds !== undefined
    );
    expect(skippedUpdate).toBeDefined();
    expect(skippedUpdate![1].skippedConversationIds).toEqual(['conv-2']);

    expect(mockDeleteConversation).toHaveBeenCalledWith('conv-1');
    expect(mockDeleteConversation).not.toHaveBeenCalledWith('conv-2');

    expect(result.status).toBe('partial');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 6. Orphan reconcile
  // -------------------------------------------------------------------------
  it('orphan reconcile: deletes a mistral document whose path has no matching current archive row', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockListDocuments.mockResolvedValueOnce([
      { id: 'doc-keep', path: 'journals/alice/conv-1.md' },
      { id: 'doc-orphan', path: 'people/deleted-person.md' }
    ]);

    await runNightlyPipeline();

    expect(mockDeleteDocument).toHaveBeenCalledWith('doc-orphan');
    expect(mockDeleteDocument).not.toHaveBeenCalledWith('doc-keep');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 7. Concurrency (lock held)
  // -------------------------------------------------------------------------
  it('concurrency: rejects with LockHeldError and never calls releaseLock when the lock is held', async () => {
    mockAcquireLock.mockResolvedValueOnce(false);

    await expect(runNightlyPipeline()).rejects.toThrow(LockHeldError);

    // acquireLock failed BEFORE the try/finally that owns releaseLock -- nothing was ever acquired.
    expect(mockReleaseLock).not.toHaveBeenCalled();
    expect(mockFindRunningJob).not.toHaveBeenCalled();
    expect(mockCreateJobLog).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 8. Upload retry
  // -------------------------------------------------------------------------
  it('upload retry: a failed replaceDocument leaves the row unsynced but the run still completes', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockReplaceDocument.mockRejectedValueOnce(new Error('network fail'));

    const result = await runNightlyPipeline();

    expect(mockMarkSynced).not.toHaveBeenCalled();
    expect(result.status).toBe('partial');
    expect(mockPruneOldVersions).toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 9. Bootstrap interaction (lightweight)
  // -------------------------------------------------------------------------
  it('bootstrap interaction: upserts context entries only for mapped current-version paths', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed('people/bob.md', 'Bob long-term content');
    await archive.seed('self-reflection/profile.md', "Yasmin's self reflection content");
    await archive.seed('general/family.md', 'Family-wide notes content');

    await runNightlyPipeline();

    expect(mockUpsertContextEntry).toHaveBeenCalledWith('Profile of Bob', expect.any(String));
    expect(mockUpsertContextEntry).toHaveBeenCalledWith('Profile of Yasmin', expect.any(String));
    expect(mockUpsertContextEntry).toHaveBeenCalledWith('Family notes', expect.any(String));

    // journals/alice/conv-1.md is an unmapped path and must not produce an upsert call.
    const titlesUpserted = mockUpsertContextEntry.mock.calls.map(call => call[0]);
    expect(titlesUpserted).not.toContain('journals/alice/conv-1.md');
    expect(mockUpsertContextEntry).toHaveBeenCalledTimes(3);

    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 10. Phase 6 privacy wiring
  // -------------------------------------------------------------------------
  it('Phase 6 strips [PRIVACY:SENSITIVE] blocks before compaction -- runCompact never sees sensitive content', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed(
      'people/bob.md',
      'Public fact about Bob.\n[PRIVACY:SENSITIVE]\nBob secretly hates broccoli.\n[/PRIVACY:SENSITIVE]\nMore public info.'
    );

    await runNightlyPipeline();

    expect(mockRunCompact).toHaveBeenCalledTimes(1);
    const [, , strippedContentPassedToCompact] = mockRunCompact.mock.calls[0];
    expect(strippedContentPassedToCompact).not.toContain('PRIVACY:SENSITIVE');
    expect(strippedContentPassedToCompact).not.toContain('secretly hates broccoli');
    expect(strippedContentPassedToCompact).toContain('Public fact about Bob.');
    expect(strippedContentPassedToCompact).toContain('More public info.');

    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });
});
