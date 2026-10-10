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
      maxRevisions: 3,
      maxIterations: 15,
      archiveKeepVersions: 10,
      eagerMaxChars: 10000,
      watermarkStalenessMs: 10 * 24 * 60 * 60 * 1000
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
  findRunningJob: jest.fn(),
  setWatermark: jest.fn()
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
jest.mock('../database/models/pending_notes.model', () => ({
  getPendingNotesMaxId: jest.fn(),
  getUnconsolidatedNotes: jest.fn(),
  clearPendingNotes: jest.fn()
}));

jest.mock('../nightly/reflection', () => ({
  buildTranscript: jest.fn(),
  runJournal: jest.fn(),
  runIntegrate: jest.fn(),
  runReview: jest.fn(),
  reviseProposal: jest.fn(),
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
  runAgentToolLoop: jest.fn()
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
  setWatermark,
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
import {
  clearPendingNotes,
  getPendingNotesMaxId,
  getUnconsolidatedNotes
} from '../database/models/pending_notes.model';
import {
  buildTranscript,
  runCompact,
  runIntegrate,
  runJournal,
  runReview,
  reviseProposal
} from '../nightly/reflection';
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
const mockSetWatermark = setWatermark as jest.Mock;

const mockGetCurrentVersion = getCurrentVersion as jest.Mock;
const mockInsertNextVersion = insertNextVersion as jest.Mock;
const mockListCurrentVersions = listCurrentVersions as jest.Mock;
const mockListUnsynced = listUnsynced as jest.Mock;
const mockMarkSynced = markSynced as jest.Mock;
const mockPruneOldVersions = pruneOldVersions as jest.Mock;

const mockUpsertContextEntry = upsertContextEntry as jest.Mock;
const mockGetPendingNotesMaxId = getPendingNotesMaxId as jest.Mock;
const mockGetUnconsolidatedNotes = getUnconsolidatedNotes as jest.Mock;
const mockClearPendingNotes = clearPendingNotes as jest.Mock;

const mockBuildTranscript = buildTranscript as jest.Mock;
const mockRunJournal = runJournal as jest.Mock;
const mockRunIntegrate = runIntegrate as jest.Mock;
const mockRunReview = runReview as jest.Mock;
const mockReviseProposal = reviseProposal as jest.Mock;
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
    mockSetWatermark.mockResolvedValue(undefined);

    mockUpsertContextEntry.mockResolvedValue('updated');
    mockGetPendingNotesMaxId.mockResolvedValue(0);
    mockGetUnconsolidatedNotes.mockResolvedValue([]);
    mockClearPendingNotes.mockResolvedValue(undefined);

    mockListConversations.mockResolvedValue([]);
    mockGetConversationMessages.mockResolvedValue([]);
    mockDeleteConversation.mockResolvedValue(undefined);
    mockListDocuments.mockResolvedValue([]);
    mockReplaceDocument.mockResolvedValue({ id: 'doc-default', path: 'default' });
    mockDeleteDocument.mockResolvedValue(undefined);

    mockBuildTranscript.mockReturnValue('transcript');
    mockRunJournal.mockResolvedValue('journal text');
    mockRunIntegrate.mockResolvedValue({ finalText: '', iterations: 0, conversationId: '' });
    mockRunReview.mockResolvedValue({ approved: true, reason: '' });
    // Default: a revision that leaves content unchanged (no conversation to clean up); tests override.
    mockReviseProposal.mockImplementation(async (_update: any, _current: any, rejected: any) => ({
      content: rejected,
      conversationId: undefined
    }));
    mockRunCompact.mockResolvedValue('compacted');
  });

  it('deletes the nightly agent integrate conversation, and a failed delete does not abort the run', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockRunIntegrate.mockResolvedValueOnce({ finalText: '', iterations: 1, conversationId: 'integrate-1' });
    mockDeleteConversation.mockImplementation(async (id: string) => {
      if (id === 'integrate-1') {
        throw new Error('boom');
      }
    });

    const result = await runNightlyPipeline();

    expect(result.status).toBe('completed');
    expect(mockDeleteConversation).toHaveBeenCalledWith('integrate-1');
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
    expect(mockSetWatermark).toHaveBeenCalledTimes(1);
    expect(mockSetWatermark).toHaveBeenCalledWith(expect.any(Date));

    expect(mockInsertNextVersion).toHaveBeenCalledWith(
      'journals/alice/conv-1.md',
      'Journal about Alice',
      expect.any(Date)
    );
    expect(mockInsertNextVersion).toHaveBeenCalledWith(
      'journals/bob/conv-2.md',
      'Journal about Bob',
      expect.any(Date)
    );
    expect(mockInsertNextVersion).toHaveBeenCalledWith(
      'journals/carol/conv-3.md',
      'Journal about Carol',
      expect.any(Date)
    );
    expect(mockInsertNextVersion).toHaveBeenCalledWith(
      'people/alice.md',
      'Alice profile content',
      expect.any(Date)
    );

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

    expect(mockInsertNextVersion).toHaveBeenCalledWith(
      'people/alice.md',
      'Existing alice content',
      expect.any(Date)
    );

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
  it('reviewer rejects one staged file: it is skipped (not written), the other proceeds, run completes', async () => {
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

    // The rejected proposal is NOT written; the accepted one is.
    expect(mockInsertNextVersion).toHaveBeenCalledWith(
      'people/alice.md',
      'Alice new profile',
      expect.any(Date)
    );
    expect(mockInsertNextVersion.mock.calls.some(call => call[0] === 'people/bob.md')).toBe(false);

    // A reviewer rejection is a handled, benign outcome -- it must not degrade the run to 'partial',
    // so the run completes and advances the watermark instead of reprocessing these conversations.
    expect(result.status).toBe('completed');
    expect(mockSetWatermark).toHaveBeenCalled();
    expect(mockDeleteConversation).toHaveBeenCalledWith('conv-1');
    expect(mockPruneOldVersions).toHaveBeenCalled();
    expect(mockPruneOldJobLogs).toHaveBeenCalled();

    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('reviewer rejects then accepts a revised proposal: the revised content is archived', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);

    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      await executeTool('stage_update', {
        path: 'people/alice.md',
        content: 'Alice profile v1',
        isNew: true
      });
      return { finalText: 'staged 1 file', iterations: 1 };
    });
    // First review rejects with feedback; after one revision, the revised content is accepted.
    mockRunReview
      .mockResolvedValueOnce({ approved: false, reason: 'missing date, please add it' })
      .mockResolvedValueOnce({ approved: true, reason: 'now includes the date' });
    mockReviseProposal.mockResolvedValue({ content: 'Alice profile v2 with date', conversationId: 'rev-1' });

    const result = await runNightlyPipeline();

    expect(mockReviseProposal).toHaveBeenCalledTimes(1);
    // The REVISED content (not the original staged proposal) is what gets archived.
    expect(mockInsertNextVersion).toHaveBeenCalledWith(
      'people/alice.md',
      'Alice profile v2 with date',
      expect.any(Date)
    );
    // The per-file revision conversation is cleaned up once the loop finishes.
    expect(mockDeleteConversation).toHaveBeenCalledWith('rev-1');

    expect(result.status).toBe('completed');
    expect(mockSetWatermark).toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('reviewer still rejects after the revision cap: WARNs, completes, sets watermark, archives nothing for that path', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);

    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      await executeTool('stage_update', {
        path: 'people/alice.md',
        content: 'Alice profile v1',
        isNew: true
      });
      await executeTool('stage_update', { path: 'people/bob.md', content: 'Bob profile v1', isNew: true });
      return { finalText: 'staged 2 files', iterations: 1 };
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Reject forever for alice, including through every revision; bob is accepted on first review.
    mockRunReview.mockImplementation(async (update: any) =>
      update.path === 'people/bob.md'
        ? { approved: true, reason: 'looks solid' }
        : { approved: false, reason: 'still missing evidence' }
    );

    const result = await runNightlyPipeline();

    // The revision loop runs exactly maxRevisions (default 3) times for the persistently rejected path.
    expect(mockReviseProposal).toHaveBeenCalledTimes(3);
    // Nothing is archived for the never-accepted path; the accepted path still is.
    expect(mockInsertNextVersion.mock.calls.some(call => call[0] === 'people/alice.md')).toBe(false);
    expect(mockInsertNextVersion).toHaveBeenCalledWith('people/bob.md', 'Bob profile v1', expect.any(Date));
    // The final rejection stays observable in the log.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('WARN Rejected staged update for people/alice.md after enough revisions')
    );

    // Rejection must not degrade the run to 'partial': it completes and advances the watermark.
    expect(result.status).toBe('completed');
    expect(mockSetWatermark).toHaveBeenCalled();
    expect(mockDeleteConversation).toHaveBeenCalledWith('conv-1');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
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

    expect(mockInsertNextVersion).toHaveBeenCalledWith(
      'journals/conv-9/conv-9.md',
      'journal text',
      expect.any(Date)
    );
    expect(mockInsertNextVersion).toHaveBeenCalledWith(
      'journals/conv-10/conv-10.md',
      'journal text',
      expect.any(Date)
    );
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
    expect(mockInsertNextVersion).toHaveBeenCalledWith(
      'journals/conv-10/conv-10.md',
      'journal text',
      expect.any(Date)
    );

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
  // 6. Watermark staleness cutoff (poison-pill valve)
  // -------------------------------------------------------------------------
  const STALE_WATERMARK = new Date(Date.now() - 11 * 24 * 60 * 60 * 1000);
  const FRESH_WATERMARK = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

  async function runWithSkippedConversation() {
    mockListConversations.mockResolvedValueOnce([conversation('conv-poison', 'Alice')]);
    mockGetConversationMessages.mockRejectedValueOnce(new Error('boom'));
    return runNightlyPipeline();
  }

  it('staleness cutoff: a stalled watermark plus skipped conversations advances the watermark to now - threshold', async () => {
    mockGetWatermark.mockResolvedValue(STALE_WATERMARK);
    const before = Date.now();
    const result = await runWithSkippedConversation();
    expect(result.status).toBe('partial');
    expect(mockSetWatermark).toHaveBeenCalledTimes(1);
    const advancedTo = mockSetWatermark.mock.calls[0][0] as Date;
    expect(advancedTo.getTime()).toBeGreaterThanOrEqual(before - 10 * 24 * 60 * 60 * 1000);
    expect(advancedTo.getTime()).toBeLessThanOrEqual(Date.now() - 10 * 24 * 60 * 60 * 1000 + 5000);
    const errorUpdate = mockUpdateJobLog.mock.calls.find(
      call => call[1] && call[1].errorMessage !== undefined
    );
    expect(errorUpdate).toBeDefined();
    expect(errorUpdate![1].errorMessage).toContain('conv-poison');
  });

  it('staleness cutoff: a stalled watermark without skipped conversations does NOT advance the watermark', async () => {
    mockGetWatermark.mockResolvedValue(STALE_WATERMARK);
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockListDocuments.mockRejectedValueOnce(new Error('listing down'));
    const result = await runNightlyPipeline();
    expect(result.status).toBe('partial');
    expect(mockSetWatermark).not.toHaveBeenCalled();
  });

  it('staleness cutoff: skipped conversations with a fresh watermark do NOT advance the watermark', async () => {
    mockGetWatermark.mockResolvedValue(FRESH_WATERMARK);
    const result = await runWithSkippedConversation();
    expect(result.status).toBe('partial');
    expect(mockSetWatermark).not.toHaveBeenCalled();
  });

  it('staleness cutoff: a partial run caused only by an upload failure does NOT advance the watermark', async () => {
    mockGetWatermark.mockResolvedValue(STALE_WATERMARK);
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockListUnsynced.mockRejectedValueOnce(new Error('db down'));
    const result = await runNightlyPipeline();
    expect(result.status).toBe('partial');
    expect(mockSetWatermark).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 7. Orphan reconcile
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

  it('orphan reconcile: deduplicates multiple docs sharing a valid path, keeping only the archived one', async () => {
    const seeded = await archive.seed('people/zara.md', 'zara content');
    await archive.markSynced(seeded.id, 'doc-current'); // authoritative archive reference

    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockListDocuments.mockResolvedValueOnce([
      { id: 'doc-stale-1', path: 'people/zara.md' },
      { id: 'doc-current', path: 'people/zara.md' },
      { id: 'doc-stale-2', path: 'people/zara.md' }
    ]);

    await runNightlyPipeline();

    expect(mockDeleteDocument).toHaveBeenCalledWith('doc-stale-1');
    expect(mockDeleteDocument).toHaveBeenCalledWith('doc-stale-2');
    expect(mockDeleteDocument).not.toHaveBeenCalledWith('doc-current');
  });

  it('orphan reconcile: leaves all copies untouched when no library doc matches the archived reference', async () => {
    const seeded = await archive.seed('people/ellena.md', 'ellena content');
    await archive.markSynced(seeded.id, 'doc-disappeared'); // archive ref points at a deleted doc

    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockListDocuments.mockResolvedValueOnce([
      { id: 'doc-copy-a', path: 'people/ellena.md' },
      { id: 'doc-copy-b', path: 'people/ellena.md' }
    ]);

    await runNightlyPipeline();

    // Cannot tell which copy is live -- delete nothing rather than risk the wrong one.
    expect(mockDeleteDocument).not.toHaveBeenCalled();
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
  // 8b. Unguarded phase read failures stay resumable ('partial'), not 'failed'
  // -------------------------------------------------------------------------
  it('Phase 5 listUnsynced failure: run resolves as partial and skips the upload instead of throwing', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockListUnsynced.mockImplementationOnce(async () => {
      throw new Error('db boom listing unsynced');
    });

    const result = await runNightlyPipeline();

    expect(result.status).toBe('partial');
    expect(mockReplaceDocument).not.toHaveBeenCalled();
    expect(mockMarkSynced).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('Phase 6 listCurrentVersions failure: run resolves as partial and leaves the eager cache untouched', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    // Phase 5 reconcile uses the first call (ok); Phase 6 uses the second (throws).
    mockListCurrentVersions
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => {
        throw new Error('db boom listing current versions');
      });

    const result = await runNightlyPipeline();

    expect(result.status).toBe('partial');
    // Phase 6 -- which upserts the mapped profile/family titles -- must NOT have run, so the eager
    // cache is untouched.
    expect(mockUpsertContextEntry).not.toHaveBeenCalled();
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
    expect(titlesUpserted).toHaveLength(3);

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

  it('Phase 6 strips a trailing ## Archiv section before compaction -- decayed facts never reach the eager cache', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed(
      'people/bob.md',
      'Public fact about Bob.\n\n## Archiv\nBob used to play piano in 2010.'
    );
    await runNightlyPipeline();
    expect(mockRunCompact).toHaveBeenCalledTimes(1);
    const [, , strippedContentPassedToCompact] = mockRunCompact.mock.calls[0];
    expect(strippedContentPassedToCompact).toContain('Public fact about Bob.');
    expect(strippedContentPassedToCompact).not.toContain('## Archiv');
    expect(strippedContentPassedToCompact).not.toContain('piano');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 11. Phase 6 empty-compaction guard
  // -------------------------------------------------------------------------
  it('Phase 6 skips the eager-cache upsert when compaction produces empty output, but does not fail the run', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed(
      'people/bob.md',
      '[PRIVACY:SENSITIVE]\nBob secretly hates broccoli.\n[/PRIVACY:SENSITIVE]'
    );
    mockRunCompact.mockImplementation(async (kind: string) => (kind === 'person' ? '   ' : 'compacted'));

    const result = await runNightlyPipeline();

    expect(mockUpsertContextEntry.mock.calls.some(call => call[0] === 'Profile of Bob')).toBe(false);
    // An empty compaction (e.g. from an empty source file) simply means nothing to compact -- it is
    // not an eager-cache failure and must not degrade the run. A completed run advances the watermark.
    expect(result.status).toBe('completed');
    expect(mockSetWatermark).toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 12. Phase 5 privacy wiring
  // -------------------------------------------------------------------------
  it('Phase 5 strips [PRIVACY:SENSITIVE] blocks before uploading to Mistral -- the local archive keeps the full content', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed(
      'people/bob.md',
      'Public fact about Bob.\n[PRIVACY:SENSITIVE]\nBob secretly hates broccoli.\n[/PRIVACY:SENSITIVE]\nMore public info.'
    );

    await runNightlyPipeline();

    const bobCall = mockReplaceDocument.mock.calls.find(call => call[0] === 'people/bob.md');
    expect(bobCall).toBeDefined();
    const uploadedContent = bobCall?.[1];
    expect(uploadedContent).not.toContain('PRIVACY:SENSITIVE');
    expect(uploadedContent).not.toContain('secretly hates broccoli');
    expect(uploadedContent).toContain('Public fact about Bob.');

    const archived = await archive.getCurrentVersion('people/bob.md');
    expect(archived?.content).toContain('secretly hates broccoli');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 13. Decay wiring: last_touched_at flows from memory_archive into the
  //     integrate tool surface and the review prompt
  // -------------------------------------------------------------------------
  it('decay wiring: list_long_term_files exposes lastTouchedAt to the integrate loop, and runReview receives it with the current content', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    const seeded = await archive.seed('people/alice.md', 'Existing alice content');
    let listed: { path: string; contentHash: string; lastTouchedAt: string }[] = [];
    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      listed = JSON.parse(await executeTool('list_long_term_files', {}));
      await executeTool('stage_update', {
        path: 'people/alice.md',
        content: 'Alice profile content',
        isNew: false
      });
      return { finalText: 'staged 1 file', iterations: 1 };
    });
    mockRunReview.mockResolvedValue({ approved: true, reason: 'looks good' });
    mockRunCompact.mockResolvedValue('compacted profile');
    mockUpsertContextEntry.mockResolvedValue('inserted');
    await runNightlyPipeline();
    const aliceEntry = listed.find(entry => entry.path === 'people/alice.md');
    expect(aliceEntry).toBeDefined();
    expect(aliceEntry!.lastTouchedAt).toBe(seeded.createdAt.toISOString());
    expect(mockRunReview).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'people/alice.md' }),
      'Existing alice content',
      seeded.createdAt.toISOString(),
      expect.any(Array),
      0
    );
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Pending-notes outbox (issue #46)
  // -------------------------------------------------------------------------

  it('outbox: undelivered notes are passed to the integrate agent, then the outbox is emptied', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockRunJournal.mockImplementation(async (userName: string) => 'Journal about ' + userName);
    mockRunIntegrate.mockResolvedValueOnce({ finalText: 'nothing to stage', iterations: 1 });
    mockGetPendingNotesMaxId.mockResolvedValueOnce(5);
    mockGetUnconsolidatedNotes.mockResolvedValueOnce([
      {
        id: 5,
        fromUsername: 'christopher',
        toUsername: 'zara',
        content: 'Please be home by 6 pm',
        createdAt: new Date('2026-07-05T15:00:00Z')
      }
    ]);
    const result = await runNightlyPipeline();
    expect(result.status).toBe('completed');
    expect(mockGetUnconsolidatedNotes).toHaveBeenCalledWith(5);
    expect(mockRunIntegrate).toHaveBeenCalledWith(expect.any(Function), [
      {
        id: 5,
        fromUsername: 'christopher',
        toUsername: 'zara',
        content: 'Please be home by 6 pm',
        createdAt: new Date('2026-07-05T15:00:00Z')
      }
    ]);
    expect(mockClearPendingNotes).toHaveBeenCalledTimes(1);
  });

  it('outbox: is emptied on a merely partial run (failed upload) because consolidation succeeded', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockRunJournal.mockImplementation(async (userName: string) => 'Journal about ' + userName);
    mockRunIntegrate.mockResolvedValueOnce({ finalText: 'nothing to stage', iterations: 1 });
    mockGetPendingNotesMaxId.mockResolvedValueOnce(9);
    mockListUnsynced.mockImplementationOnce(() => {
      throw new Error('db read failed');
    });
    const result = await runNightlyPipeline();
    expect(result.status).toBe('partial');
    expect(mockClearPendingNotes).toHaveBeenCalledTimes(1);
    expect(mockClearPendingNotes).toHaveBeenCalledWith(9);
  });

  it('outbox: is NOT emptied when the review/archive phase failed (notes stay for tomorrow)', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockRunJournal.mockImplementation(async (userName: string) => 'Journal about ' + userName);
    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      await executeTool('stage_update', {
        path: 'people/alice.md',
        content: 'Alice profile content',
        isNew: true
      });
      return { finalText: 'staged', iterations: 1 };
    });
    // The first two getCurrentVersion calls belong to phase 2 (journal check + re-read);
    // the third is the failing phase-4 archive read of the staged update's current content.
    mockGetCurrentVersion
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ content: 'Journal about Alice' })
      .mockImplementationOnce(() => {
        throw new Error('archive read failed');
      });
    const result = await runNightlyPipeline();
    expect(result.status).toBe('partial');
    expect(mockClearPendingNotes).not.toHaveBeenCalled();
  });

  it('outbox: a failed note read does not fail the run, and the outbox is NOT cleared (notes stay for tomorrow)', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockRunJournal.mockImplementation(async (userName: string) => 'Journal about ' + userName);
    mockRunIntegrate.mockResolvedValueOnce({ finalText: 'nothing to stage', iterations: 1 });
    mockGetUnconsolidatedNotes.mockRejectedValueOnce(new Error('db down'));
    const result = await runNightlyPipeline();
    expect(result.status).toBe('completed');
    expect(mockRunIntegrate).toHaveBeenCalledWith(expect.any(Function), []);
    expect(mockClearPendingNotes).not.toHaveBeenCalled();
  });

  it('outbox: is NOT emptied when the integrate loop hit maxIterations (notes may be unconsolidated)', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockRunJournal.mockImplementation(async (userName: string) => 'Journal about ' + userName);
    mockRunIntegrate.mockResolvedValueOnce({ finalText: 'staged', iterations: 15 });
    const result = await runNightlyPipeline();
    // integrateTruncated itself already degrades the run to 'partial'
    expect(result.status).toBe('partial');
    expect(mockClearPendingNotes).not.toHaveBeenCalled();
  });

  it('outbox: clearing deletes up to the MAX(id) over ALL notes, so a delivered-only outbox still empties', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockRunJournal.mockImplementation(async (userName: string) => 'Journal about ' + userName);
    mockRunIntegrate.mockResolvedValueOnce({ finalText: 'nothing to stage', iterations: 1 });
    // All notes already delivered individually: undelivered set is empty, but the table still
    // holds rows -- the watermark must come from MAX(id), not from the undelivered subset.
    mockGetPendingNotesMaxId.mockResolvedValueOnce(23);
    mockGetUnconsolidatedNotes.mockResolvedValueOnce([]);
    const result = await runNightlyPipeline();
    expect(result.status).toBe('completed');
    expect(mockClearPendingNotes).toHaveBeenCalledTimes(1);
    expect(mockClearPendingNotes).toHaveBeenCalledWith(23);
  });

  it('outbox: skips the DELETE entirely when the table is empty (no pointless clear)', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockRunJournal.mockImplementation(async (userName: string) => 'Journal about ' + userName);
    mockRunIntegrate.mockResolvedValueOnce({ finalText: 'nothing to stage', iterations: 1 });
    mockGetPendingNotesMaxId.mockResolvedValueOnce(0);
    const result = await runNightlyPipeline();
    expect(result.status).toBe('completed');
    expect(mockClearPendingNotes).not.toHaveBeenCalled();
  });
});
