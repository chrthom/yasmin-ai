// Integration tests for the nightly pipeline orchestration (src/nightly/pipeline.ts).
//
// Mocking strategy:
// - '../nightly/reflection' is mocked directly (not the real reflection.ts + a mocked mistral_api) so
//   these tests assert pipeline.ts's ORCHESTRATION logic, not reflection.ts's prompt wording.
// - '../database/models/memory_archive.model' is backed by a small in-memory fake (MemoryArchiveFake)
//   that mirrors the real module's hash-based no-churn versioning, so multi-call interactions (the
//   journal loop reading back what it just wrote, phase 4's review + archive, phase 6/7 reconcile) are
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
      nightlyAgentId: 'nightly-agent-1',
      requestTimeoutMs: 30_000,
      maxToolCalls: 5
    },
    context: {
      familyNotesTitle: 'Family notes',
      profileOfYasminTitle: 'Profile of Yasmin'
    },
    nightly: {
      lockStaleMs: 2 * 60 * 60 * 1000,
      maxRevisions: 3,
      maxIterations: 25,
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
jest.mock('../database/models/intraday_notes.model', () => ({
  getIntradayNotesMaxId: jest.fn(),
  getUnconsolidatedNotes: jest.fn(),
  clearIntradayNotes: jest.fn()
}));

jest.mock('../nightly/reflection', () => ({
  buildTranscript: jest.fn(),
  runJournal: jest.fn(),
  runIntegrate: jest.fn(),
  runReview: jest.fn(),
  reviseProposal: jest.fn(),
  runCompact: jest.fn()
}));

jest.mock('../nightly/dream', () => {
  // The soft-evidence extraction (recentDreamReflections) is exercised through the REAL
  // implementation -- the fold-in tests assert its actual trimming behavior -- while the
  // agent-calling and cadence functions stay mocked to keep Phase 5 controllable.
  const actualDream = jest.requireActual('../nightly/dream');
  return {
    DREAM_EVIDENCE_HEADER: actualDream.DREAM_EVIDENCE_HEADER,
    DREAM_EVIDENCE_MAX_CHARS: actualDream.DREAM_EVIDENCE_MAX_CHARS,
    recentDreamReflections: actualDream.recentDreamReflections,
    DREAM_REFLECTION_PATH: 'self-reflection/dreams.md',
    appendDreamReflection: jest.fn(
      (current: string | null, dateStr: string, reflection: string) =>
        (current === null ? '' : current + '\n\n') + '## Traum vom ' + dateStr + '\n\n' + reflection
    ),
    dreamFilePath: jest.fn((now: Date) => {
      const y = now.getUTCFullYear();
      const m = String(now.getUTCMonth() + 1).padStart(2, '0');
      const d = String(now.getUTCDate()).padStart(2, '0');
      return `journals/dreams/${y}-${m}-${d}.md`;
    }),
    dreamDateFromPath: jest.fn((filePath: string) => {
      const prefix = 'journals/dreams/';
      if (!filePath.startsWith(prefix) || !filePath.endsWith('.md')) {
        return null;
      }
      // Mirrors the real module's date-shape guard so a regression of that guard is visible here.
      const stem = filePath.slice(prefix.length, -'.md'.length);
      return /^\d{4}-\d{2}-\d{2}$/.test(stem) ? stem : null;
    }),
    hasReflectionForDate: jest.fn(
      (current: string | null, dateStr: string) =>
        current !== null && current.includes('## Traum vom ' + dateStr)
    ),
    findUnreflectedDream: jest.fn((currentVersions: any[], reflectionContent: string | null) => {
      const prefix = 'journals/dreams/';
      const dreams = currentVersions
        .filter(
          (row: any) =>
            row.filePath.startsWith(prefix) &&
            row.filePath.endsWith('.md') &&
            /^\d{4}-\d{2}-\d{2}$/.test(row.filePath.slice(prefix.length, -'.md'.length))
        )
        .sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime());
      for (const dream of dreams) {
        const dateStr = dream.filePath.slice(prefix.length, -'.md'.length);
        if (reflectionContent === null || !reflectionContent.includes('## Traum vom ' + dateStr)) {
          return dream;
        }
      }
      return null;
    }),
    findLastDreamAt: jest.fn(),
    runDream: jest.fn(),
    runDreamReflection: jest.fn(),
    selectDreamSources: jest.fn(),
    shouldDreamTonight: jest.fn()
  };
});
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
import { parseMood } from '../nightly/mood';
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
  clearIntradayNotes,
  getIntradayNotesMaxId,
  getUnconsolidatedNotes
} from '../database/models/intraday_notes.model';
import {
  buildTranscript,
  runCompact,
  runIntegrate,
  runJournal,
  runReview,
  reviseProposal
} from '../nightly/reflection';
import {
  appendDreamReflection,
  dreamDateFromPath,
  dreamFilePath,
  findLastDreamAt,
  findUnreflectedDream,
  hasReflectionForDate,
  runDream,
  runDreamReflection,
  selectDreamSources,
  shouldDreamTonight
} from '../nightly/dream';
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
const mockGetIntradayNotesMaxId = getIntradayNotesMaxId as jest.Mock;
const mockGetUnconsolidatedNotes = getUnconsolidatedNotes as jest.Mock;
const mockClearIntradayNotes = clearIntradayNotes as jest.Mock;

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
const mockFindLastDreamAt = findLastDreamAt as jest.Mock;
const mockRunDream = runDream as jest.Mock;
const mockRunDreamReflection = runDreamReflection as jest.Mock;
const mockSelectDreamSources = selectDreamSources as jest.Mock;
const mockShouldDreamTonight = shouldDreamTonight as jest.Mock;

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
    mockGetIntradayNotesMaxId.mockResolvedValue(0);
    mockGetUnconsolidatedNotes.mockResolvedValue([]);
    mockClearIntradayNotes.mockResolvedValue(undefined);

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
    // Default: no dream tonight (cadence) -- individual dream tests opt back in explicitly.
    mockFindLastDreamAt.mockReturnValue(new Date(Date.now() - 1 * 24 * 60 * 60 * 1000));
    mockShouldDreamTonight.mockReturnValue(false);
    mockSelectDreamSources.mockReturnValue([]);
    mockRunDream.mockResolvedValue('Ein seltsamer Traum.');
    mockRunDreamReflection.mockResolvedValue('Ich fuhle mich davon beruhrt.');
    (appendDreamReflection as jest.Mock).mockImplementation(
      (current: string | null, dateStr: string, reflection: string) =>
        (current === null ? '' : current + '\n\n') + '## Traum vom ' + dateStr + '\n\n' + reflection
    );
    (dreamFilePath as jest.Mock).mockImplementation((now: Date) => {
      const y = now.getUTCFullYear();
      const m = String(now.getUTCMonth() + 1).padStart(2, '0');
      const d = String(now.getUTCDate()).padStart(2, '0');
      return `journals/dreams/${y}-${m}-${d}.md`;
    });
    (hasReflectionForDate as jest.Mock).mockImplementation(
      (current: string | null, dateStr: string) =>
        current !== null && current.includes('## Traum vom ' + dateStr)
    );
    (dreamDateFromPath as jest.Mock).mockImplementation((filePath: string) => {
      const prefix = 'journals/dreams/';
      if (!filePath.startsWith(prefix) || !filePath.endsWith('.md')) {
        return null;
      }
      const stem = filePath.slice(prefix.length, -'.md'.length);
      return /^\d{4}-\d{2}-\d{2}$/.test(stem) ? stem : null;
    });
    (findUnreflectedDream as jest.Mock).mockImplementation(
      (currentVersions: any[], reflectionContent: string | null) => {
        const prefix = 'journals/dreams/';
        const dreams = currentVersions
          .filter(
            (row: any) =>
              row.filePath.startsWith(prefix) &&
              row.filePath.endsWith('.md') &&
              /^\d{4}-\d{2}-\d{2}$/.test(row.filePath.slice(prefix.length, -'.md'.length))
          )
          .sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime());
        for (const dream of dreams) {
          const dateStr = dream.filePath.slice(prefix.length, -'.md'.length);
          if (reflectionContent === null || !reflectionContent.includes('## Traum vom ' + dateStr)) {
            return dream;
          }
        }
        return null;
      }
    );
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

    // Phase 1 persists the collected batch right away (the crash-recovery watermark for a resume):
    // a fresh NON-empty run must record processedConversationIds + '1-collect' so a crash later in
    // the run replays exactly this batch instead of re-collecting.
    expect(mockUpdateJobLog).toHaveBeenCalledWith(1, {
      processedConversationIds: ['conv-1', 'conv-2', 'conv-3'],
      lastCompletedPhase: '1-collect'
    });

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
    // Mark the seeded row as already synced -- otherwise Phase 6 would re-upload it regardless of
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

    // Both conversations are still cleaned up in Phase 9 regardless of which path journaled them.
    expect(mockDeleteConversation).toHaveBeenCalledWith('conv-9');
    expect(mockDeleteConversation).toHaveBeenCalledWith('conv-10');

    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 4b. Empty-batch short-circuit (issue #109)
  // -------------------------------------------------------------------------
  it('empty batch (fresh): skips phases 2-9 entirely -- no LLM calls, no Mistral writes, completed row + watermark', async () => {
    // Default mockListConversations resolves to [] -- nothing to collect.
    const result = await runNightlyPipeline();

    expect(result.status).toBe('completed');
    expect(result.conversationsProcessed).toBe(0);
    expect(result.jobId).toBe(1);

    // The skip decision consults the outbox first -- with no conversations AND no undelivered
    // notes there is genuinely nothing only the nightly job could do.
    expect(mockGetIntradayNotesMaxId).toHaveBeenCalledTimes(1);
    expect(mockGetUnconsolidatedNotes).toHaveBeenCalledTimes(1);

    // No LLM calls at all: journal, integrate, review, revise, compact.
    expect(mockRunJournal).not.toHaveBeenCalled();
    expect(mockRunIntegrate).not.toHaveBeenCalled();
    expect(mockRunReview).not.toHaveBeenCalled();
    expect(mockReviseProposal).not.toHaveBeenCalled();
    expect(mockRunCompact).not.toHaveBeenCalled();

    // No Mistral writes or deletes, and no conversation reads either.
    expect(mockGetConversationMessages).not.toHaveBeenCalled();
    expect(mockReplaceDocument).not.toHaveBeenCalled();
    expect(mockDeleteDocument).not.toHaveBeenCalled();
    expect(mockDeleteConversation).not.toHaveBeenCalled();

    // Nothing is archived and the eager cache is not rewritten.
    expect(mockInsertNextVersion).not.toHaveBeenCalled();
    expect(mockUpsertContextEntry).not.toHaveBeenCalled();

    // The job log records exactly one write: the completed row with zero conversations (no
    // empty processedConversationIds batch is persisted).
    expect(mockUpdateJobLog).toHaveBeenCalledTimes(1);
    expect(mockUpdateJobLog).toHaveBeenCalledWith(1, {
      status: 'completed',
      completedAt: expect.any(Date),
      lastCompletedPhase: '1-collect',
      conversationsProcessed: 0
    });

    // The watermark advances to the Phase-1 snapshot time, like any completed run.
    expect(mockSetWatermark).toHaveBeenCalledTimes(1);
    expect(mockSetWatermark).toHaveBeenCalledWith(expect.any(Date));

    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('empty batch (resumed): an orphan row whose effective batch is empty short-circuits the same way', async () => {
    // Crash between createJobLog() and the processedConversationIds write: the orphan row exists
    // but its batch was never recorded, so the run re-collects fresh -- and finds nothing.
    const orphan: NightlyJobLog = {
      id: 42,
      startedAt: new Date('2026-07-05T22:00:00Z'),
      completedAt: null,
      status: 'running',
      lastCompletedPhase: null,
      processedConversationIds: [],
      skippedConversationIds: [],
      errorMessage: null,
      conversationsProcessed: 0,
      filesUpdated: 0,
      filesCreated: 0
    };
    mockFindRunningJob.mockResolvedValueOnce(orphan);
    // Default mockListConversations resolves to [] -- the effective batch stays empty.

    const result = await runNightlyPipeline();

    // The orphan's row is reused (no new job row created) and it is the one being completed.
    expect(mockCreateJobLog).not.toHaveBeenCalled();
    expect(result.jobId).toBe(42);
    expect(result.status).toBe('completed');
    expect(result.conversationsProcessed).toBe(0);

    // Same skip shape as the fresh case: no LLM calls, no Mistral writes/deletes.
    expect(mockRunJournal).not.toHaveBeenCalled();
    expect(mockRunIntegrate).not.toHaveBeenCalled();
    expect(mockRunReview).not.toHaveBeenCalled();
    expect(mockRunCompact).not.toHaveBeenCalled();
    expect(mockGetConversationMessages).not.toHaveBeenCalled();
    expect(mockDeleteConversation).not.toHaveBeenCalled();
    expect(mockDeleteDocument).not.toHaveBeenCalled();
    expect(mockReplaceDocument).not.toHaveBeenCalled();

    const completedUpdate = mockUpdateJobLog.mock.calls.find(call => call[1]?.status === 'completed');
    expect(completedUpdate).toBeDefined();
    expect(completedUpdate![1].conversationsProcessed).toBe(0);

    expect(mockSetWatermark).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('empty batch + undelivered notes: does NOT skip -- the run consolidates the pending notes with zero conversations', async () => {
    // Zero conversations, but the outbox still holds an undelivered note: the skip must not
    // strand it, so the consolidation path (phases 3/4/8) keeps running.
    mockGetIntradayNotesMaxId.mockResolvedValueOnce(5);
    mockGetUnconsolidatedNotes.mockResolvedValueOnce([
      {
        id: 5,
        fromUsername: 'christopher',
        toUsername: 'zara',
        content: 'Please be home by 6 pm',
        createdAt: new Date('2026-07-05T15:00:00Z')
      }
    ]);
    mockRunIntegrate.mockResolvedValueOnce({ finalText: 'consolidated the note', iterations: 1 });

    const result = await runNightlyPipeline();

    // No conversation was journaled or deleted, but integrate saw the note as evidence...
    expect(mockRunJournal).not.toHaveBeenCalled();
    expect(mockRunIntegrate).toHaveBeenCalledTimes(1);
    expect(mockRunIntegrate).toHaveBeenCalledWith(expect.any(Function), [
      {
        id: 5,
        fromUsername: 'christopher',
        toUsername: 'zara',
        content: 'Please be home by 6 pm',
        createdAt: new Date('2026-07-05T15:00:00Z')
      }
    ]);
    expect(mockDeleteConversation).not.toHaveBeenCalled();

    // ...and the outbox was emptied after the successful consolidation.
    expect(mockClearIntradayNotes).toHaveBeenCalledTimes(1);
    expect(mockClearIntradayNotes).toHaveBeenCalledWith(5);

    expect(result.status).toBe('completed');
    expect(result.conversationsProcessed).toBe(0);
    expect(mockSetWatermark).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('empty batch + undelivered notes: review and revision ground in the notes, so the note survives into memory', async () => {
    // The quiet-night loss guard: the reviewer's evidence base must include the undelivered notes.
    // Without them a note-derived fact looks invented (the journals are empty on this path), gets
    // rejected, and Phase 8 would still empty the outbox -- silently losing the note's content.
    mockGetIntradayNotesMaxId.mockResolvedValueOnce(5);
    const notes = [
      {
        id: 5,
        fromUsername: 'christopher',
        toUsername: 'zara',
        content: 'Please be home by 6 pm',
        createdAt: new Date('2026-07-05T15:00:00Z')
      }
    ];
    mockGetUnconsolidatedNotes.mockResolvedValueOnce(notes);
    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      await executeTool('stage_update', {
        path: 'people/zara.md',
        content: 'Zara profile with the note fact',
        isNew: true
      });
      return { finalText: 'staged the note fact', iterations: 1 };
    });
    // The first review rejects (as it would with empty journals), the revision re-grounds in the
    // notes, the re-review approves.
    mockRunReview
      .mockResolvedValueOnce({ approved: false, reason: 'fact not grounded in the journals' })
      .mockResolvedValueOnce({ approved: true, reason: 'grounded in the note' });

    const result = await runNightlyPipeline();

    // Every review call and the revision call carried the notes as evidence.
    expect(mockRunReview).toHaveBeenCalledTimes(2);
    expect(mockRunReview.mock.calls[0][6]).toEqual(notes);
    expect(mockRunReview.mock.calls[1][6]).toEqual(notes);
    expect(mockReviseProposal).toHaveBeenCalledTimes(1);
    expect(mockReviseProposal.mock.calls[0][6]).toEqual(notes);

    // The note-derived fact was archived, so emptying the outbox no longer loses it.
    expect(mockInsertNextVersion).toHaveBeenCalledWith(
      'people/zara.md',
      'Zara profile with the note fact',
      expect.any(Date)
    );
    expect(mockClearIntradayNotes).toHaveBeenCalledWith(5);

    expect(result.status).toBe('completed');
    expect(mockSetWatermark).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('empty batch + failed notes read: skips (no LLM calls) and leaves the outbox untouched', async () => {
    // The outbox state is unknown, but the skip performs no outbox writes -- pending notes are
    // never lost, they stay for the next run. And with zero conversations there is no journal
    // evidence, so running phases 2-9 could only stage spurious updates.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockGetUnconsolidatedNotes.mockRejectedValueOnce(new Error('db down'));

    const result = await runNightlyPipeline();

    expect(result.status).toBe('completed');
    expect(mockRunIntegrate).not.toHaveBeenCalled();
    expect(mockRunJournal).not.toHaveBeenCalled();
    expect(mockClearIntradayNotes).not.toHaveBeenCalled();
    expect(mockSetWatermark).toHaveBeenCalledTimes(1);
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
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
  it('Phase 6 listUnsynced failure: run resolves as partial and skips the upload instead of throwing', async () => {
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

  it('Phase 7 listCurrentVersions failure: run resolves as partial and leaves the eager cache untouched', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    // listCurrentVersions is called in order by the topics barrier load, the dream phase's two
    // listings, Phase 6's upload reconcile, and Phase 7's eager listing -- the first four stay
    // healthy, the fifth throws.
    mockListCurrentVersions
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => {
        throw new Error('db boom listing current versions');
      });

    const result = await runNightlyPipeline();

    expect(result.status).toBe('partial');
    // Phase 7 -- which upserts the mapped profile/family titles -- must NOT have run, so the eager
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
  // 9b. Mood decay + fold-in (issue #48)
  // -------------------------------------------------------------------------

  it('mood: deterministic decay applies without an agent update; a fully faded mood drops its narrative', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    // A mood whose updatedAt is ~290 one-day half-lives before the run date: code must decay
    // it to zero with no agent update, and the stale reason must fade WITH the numbers.
    await archive.seed('self-reflection/profile.md', 'Ich bin Yasmin. Ich mag lange Gespraeche.');
    await archive.seed(
      'self-reflection/mood.md',
      'valence: 0.8\nenergy: 0.6\nhalfLifeDays: 1\nupdatedAt: 2026-01-01T22:00:00Z\n\n' +
        'Christopher hat mich heute heftig kritisiert.'
    );

    await runNightlyPipeline();

    // The decayed archive version persists with the narrative dropped...
    const moodRow = await archive.getCurrentVersion('self-reflection/mood.md');
    expect(moodRow).not.toBeNull();
    const moodContent = moodRow!.content;
    const decayedMood = parseMood(moodContent);
    expect(decayedMood).not.toBeNull();
    // 2026-01-01 is ~290 one-day half-lives before the run date -- far past the ~6.3 half-lives
    // it takes 0.8 to fall under the 0.01 decay epsilon -- so the decayed valence must be fully
    // neutralized (0), and the assertion must not accidentally match the seeded 0.8 (a
    // toContain('valence: 0') would).
    expect(decayedMood!.valence).toBe(0);
    expect(decayedMood!.energy).toBe(0);
    expect(moodContent).not.toContain('Christopher hat mich heute heftig kritisiert.');

    // ...so the yasmin compaction source carries no stale current-mood section: the reason
    // cannot outlive its mood in the eager profile.
    const yasminCall = mockRunCompact.mock.calls.find(call => call[0] === 'yasmin');
    expect(yasminCall).toBeDefined();
    expect(yasminCall![2]).not.toContain('My current mood');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('mood: a mid-decay value is halved per half-life, proving decay actually applied', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    // updatedAt ~3 collected-times in the past is impossible to control precisely here, so
    // instead assert the deterministic property on the unit level (see mood.test.ts) and here
    // only that a stale mood gets a NEW version (decay applied at all) with a refreshed header.
    await archive.seed(
      'self-reflection/mood.md',
      'valence: 0.8\nenergy: 0.6\nhalfLifeDays: 1\nupdatedAt: 2026-01-01T22:00:00Z\n\nAlt.'
    );
    const seeded = await archive.getCurrentVersion('self-reflection/mood.md');
    await runNightlyPipeline();
    const moodRow = await archive.getCurrentVersion('self-reflection/mood.md');
    expect(moodRow!.version).toBeGreaterThan(seeded!.version);
  });

  it('mood: a [PRIVACY:SENSITIVE] passage in the mood narrative never reaches the compactor', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed('self-reflection/profile.md', 'Ich bin Yasmin.');
    // updatedAt 12h ago with a 1-day half-life: the mood decays (~0.57/0.42) but is NOT fully
    // faded, so the narrative survives decay and the fold-in below actually has text to strip.
    await archive.seed(
      'self-reflection/mood.md',
      'valence: 0.8\nenergy: 0.6\nhalfLifeDays: 1\nupdatedAt: ' +
        new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString() +
        '\n\nIch bin today frustriert.\n[PRIVACY:SENSITIVE]\nGeheimes: ich hatte einen Streit mit R.\n[/PRIVACY:SENSITIVE]'
    );
    await runNightlyPipeline();
    const compactSource = mockRunCompact.mock.calls.find(call => call[0] === 'yasmin')[2];
    expect(compactSource).toContain('My current mood');
    expect(compactSource).toContain('frustriert');
    expect(compactSource).not.toContain('PRIVACY:SENSITIVE');
    expect(compactSource).not.toContain('Geheimes');
  });

  it('mood: an unparsable header skips the fold-in (no stale n/a mood in the eager profile)', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed('self-reflection/profile.md', 'Ich bin Yasmin.');
    await archive.seed('self-reflection/mood.md', 'kein header, nur narrative');
    await runNightlyPipeline();
    const yasminCall = mockRunCompact.mock.calls.find(call => call[0] === 'yasmin');
    expect(yasminCall[2]).not.toContain('n/a');
    expect(yasminCall[2]).not.toContain('current mood');
  });

  it('mood: a staged mood update with a bogus updatedAt is re-stamped with the archive time', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    // The agent stages a hallucinated far-future date; the pipeline must overwrite it with the
    // archive stamp so decay measures from the real commit time, not the agent's lie.
    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      await executeTool('stage_update', {
        path: 'self-reflection/mood.md',
        content:
          'valence: 0.9\nenergy: 0.7\nhalfLifeDays: 1\nupdatedAt: 2030-01-01T00:00:00Z\n\nIch bin gut gelaunt.',
        isNew: true
      });
      return { finalText: 'staged mood', iterations: 1 };
    });
    mockRunReview.mockResolvedValue({ approved: true, reason: 'ok' });

    await runNightlyPipeline();

    const moodRow = await archive.getCurrentVersion('self-reflection/mood.md');
    expect(moodRow).not.toBeNull();
    const mood = parseMood(moodRow!.content);
    expect(mood).not.toBeNull();
    expect(mood!.valence).toBe(0.9);
    // The rendered header stores second precision, so compare at that granularity.
    expect(Math.floor(mood!.updatedAt.getTime() / 1000)).toBe(
      Math.floor(moodRow!.createdAt.getTime() / 1000)
    );
    // The bogus 2030 date must be gone.
    expect(mood!.updatedAt.getFullYear()).toBeLessThan(2030);
  });

  it('mood: a fully decayed (neutral) mood produces no new version and no churn', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    const seeded = await archive.seed(
      'self-reflection/mood.md',
      'valence: 0\nenergy: 0\nhalfLifeDays: 1\nupdatedAt: 2026-01-01T22:00:00Z\n\nAlles neutral.'
    );
    await runNightlyPipeline();
    const moodRow = await archive.getCurrentVersion('self-reflection/mood.md');
    expect(moodRow!.version).toBe(seeded.version);
  });

  // -------------------------------------------------------------------------
  // 9d. Dream-reflection soft evidence in the yasmin compaction (issue #126)
  // -------------------------------------------------------------------------

  it('dream evidence: recent dream reflections ride along as soft evidence in the yasmin compaction source', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed('self-reflection/profile.md', 'Ich bin Yasmin.');
    await archive.seed(
      'self-reflection/dreams.md',
      '## Traum vom 2026-10-01\n\nErste Reflexion.\n\n## Traum vom 2026-10-05\n\nDer Traum hat mich an meine Ungeduld erinnert.'
    );

    await runNightlyPipeline();

    // Phase 5 must not have touched the seeded reflections (no dream tonight, none unreflected):
    // the fold-in below reads exactly what the dream phase wrote on earlier nights.
    const yasminCall = mockRunCompact.mock.calls.find(call => call[0] === 'yasmin');
    expect(yasminCall).toBeDefined();
    expect(yasminCall![2]).toContain('Ich bin Yasmin.');
    expect(yasminCall![2]).toContain('## My reflections on my dreams');
    expect(yasminCall![2]).toContain('Traum vom 2026-10-01');
    expect(yasminCall![2]).toContain('Ungeduld');
  });

  it('dream evidence: without a dreams.md row the yasmin compaction source carries no dream section', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed('self-reflection/profile.md', 'Ich bin Yasmin.');

    await runNightlyPipeline();

    const yasminCall = mockRunCompact.mock.calls.find(call => call[0] === 'yasmin');
    expect(yasminCall).toBeDefined();
    expect(yasminCall![2]).not.toContain('My reflections on my dreams');
  });

  it('dream evidence: a [PRIVACY:SENSITIVE] passage in the reflections never reaches the compactor', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed('self-reflection/profile.md', 'Ich bin Yasmin.');
    await archive.seed(
      'self-reflection/dreams.md',
      '## Traum vom 2026-10-05\n\nOeffentliche Reflexion.\n[PRIVACY:SENSITIVE]\nGeheimes: ich traume von R.\n[/PRIVACY:SENSITIVE]'
    );

    await runNightlyPipeline();

    const compactSource = mockRunCompact.mock.calls.find(call => call[0] === 'yasmin')![2];
    expect(compactSource).toContain('Oeffentliche Reflexion.');
    expect(compactSource).not.toContain('PRIVACY:SENSITIVE');
    expect(compactSource).not.toContain('Geheimes');
  });

  it('dream evidence: only the most recent entries are passed once dreams.md exceeds the evidence cap', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed('self-reflection/profile.md', 'Ich bin Yasmin.');
    const longEntry = (date: string, text: string) =>
      '## Traum vom ' + date + '\n\n' + text + 'x'.repeat(3000);
    await archive.seed(
      'self-reflection/dreams.md',
      [
        longEntry('2026-09-01', 'Alte Reflexion.'),
        longEntry('2026-10-01', 'Mittlere Reflexion.'),
        longEntry('2026-10-05', 'Neue Reflexion.')
      ].join('\n\n')
    );

    await runNightlyPipeline();

    // The mock factory passes the REAL recentDreamReflections through, so this asserts the actual
    // trimming: the cap (4000) fits one ~3000-char entry but not two, so only the newest survives.
    const compactSource = mockRunCompact.mock.calls.find(call => call[0] === 'yasmin')![2];
    expect(compactSource).toContain('Neue Reflexion.');
    expect(compactSource).not.toContain('Alte Reflexion.');
    expect(compactSource).not.toContain('Mittlere Reflexion.');
  });

  it('dream evidence: people/ and family compaction sources never see dream material (the fact gate)', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed('self-reflection/profile.md', 'Ich bin Yasmin.');
    await archive.seed('people/bob.md', 'Bobs Profil.');
    await archive.seed('general/family.md', 'Familiennotizen.');
    await archive.seed('self-reflection/dreams.md', '## Traum vom 2026-10-05\n\nReflexion ueber den Traum.');

    await runNightlyPipeline();

    // The deliberate asymmetry (issue #126): dream reflections flow into Profile of Yasmin ONLY
    // -- people/ and general/ files keep receiving dream-derived insights exclusively through the
    // normal integrate/review chain, so their compaction inputs must stay dream-free.
    const personCall = mockRunCompact.mock.calls.find(call => call[0] === 'person');
    expect(personCall).toBeDefined();
    expect(personCall![2]).not.toContain('My reflections on my dreams');
    expect(personCall![2]).not.toContain('Reflexion ueber den Traum.');
    const familyCall = mockRunCompact.mock.calls.find(call => call[0] === 'family');
    expect(familyCall).toBeDefined();
    expect(familyCall![2]).not.toContain('My reflections on my dreams');
    expect(familyCall![2]).not.toContain('Reflexion ueber den Traum.');
    // dreams.md itself has no context_entries mapping: no eager entry is created for it either.
    const titlesUpserted = mockUpsertContextEntry.mock.calls.map(call => call[0]);
    expect(titlesUpserted).toHaveLength(3);
    expect(titlesUpserted).toEqual(
      expect.arrayContaining(['Profile of Yasmin', 'Profile of Bob', 'Family notes'])
    );
  });

  // -------------------------------------------------------------------------
  // 9c. Topics layer wiring
  // -------------------------------------------------------------------------

  it('topics duplicate barrier: pipeline seeds the reviewer with archived topics, filters topics/, and excludes the proposed path', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    await archive.seed(
      'topics/urlaub-planung.md',
      'Aliases: Urlaub Planung, Sommerreise\nFamilie will ans Meer.'
    );
    await archive.seed('people/bob.md', 'Bob profile'); // non-topic seed must not reach the barrier
    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      await executeTool('stage_update', {
        path: 'topics/urlaub-aktivitaeten.md',
        content: 'Aliases: Ausflüge\nWas die Familie am Urlaubsort tun will.',
        isNew: true
      });
      return { finalText: 'staged a topic', iterations: 1 };
    });
    const seenTopics: any[][] = [];
    mockRunReview.mockImplementation(
      async (
        _update: any,
        _current: any,
        _lastTouchedAt: any,
        _journals: any,
        _attempt: any,
        existingTopics: any
      ) => {
        seenTopics.push(existingTopics);
        return { approved: true, reason: 'ok' };
      }
    );
    await runNightlyPipeline();
    // Every review attempt saw exactly the archived topics -- the people/ seed excluded, the
    // proposal's own path excluded, the other archived topic present with its content.
    expect(seenTopics.length).toBeGreaterThan(0);
    for (const topics of seenTopics) {
      expect(topics.map((t: any) => t.path)).toEqual(['topics/urlaub-planung.md']);
    }
    expect(seenTopics[0][0].content).toContain('Sommerreise');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('same-run duplicate barrier: a topic approved earlier in the run is part of the next review barrier', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      await executeTool('stage_update', {
        path: 'topics/urlaub-planung.md',
        content: 'Aliases: Sommerreise',
        isNew: true
      });
      await executeTool('stage_update', {
        path: 'topics/urlaub-aktivitaeten.md',
        content: 'Aliases: Urlaub Aktivitäten',
        isNew: true
      });
      return { finalText: 'staged two topics', iterations: 1 };
    });
    const seenTopics: any[][] = [];
    mockRunReview.mockImplementation(
      async (
        update: any,
        _current: any,
        _lastTouchedAt: any,
        _journals: any,
        _attempt: any,
        existingTopics: any
      ) => {
        seenTopics.push(existingTopics);
        return { approved: true, reason: 'ok' };
      }
    );
    await runNightlyPipeline();
    // First topic review starts from the (empty) archive; the second must already see the first.
    expect(seenTopics[0]).toEqual([]);
    expect(seenTopics[1].map((t: any) => t.path)).toEqual(['topics/urlaub-planung.md']);
    // Both were archived (the reviewer approved both) -- the barrier's job is visibility, not rejection.
    expect(mockInsertNextVersion).toHaveBeenCalledWith(
      'topics/urlaub-planung.md',
      'Aliases: Sommerreise',
      expect.any(Date)
    );
    expect(mockInsertNextVersion).toHaveBeenCalledWith(
      'topics/urlaub-aktivitaeten.md',
      'Aliases: Urlaub Aktivitäten',
      expect.any(Date)
    );
  });

  it('topic index is advisory: archived last, as staged, without line-level validation', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      await executeTool('stage_update', {
        path: 'general/topic-index.md',
        content:
          'Index:\n' +
          'topics/urlaub-planung.md - Familienurlaub - Alice, Bob\n' +
          'topics/abgelehntes-thema.md - nie archiviert - Alice',
        isNew: true
      });
      await executeTool('stage_update', {
        path: 'topics/urlaub-planung.md',
        content: 'Aliases: Sommerreise',
        isNew: true
      });
      return { finalText: 'staged index and topic', iterations: 1 };
    });
    mockRunReview.mockResolvedValue({ approved: true, reason: 'ok' });
    const result = await runNightlyPipeline();
    const indexCall = mockInsertNextVersion.mock.calls.find(call => call[0] === 'general/topic-index.md');
    expect(indexCall).toBeDefined();
    // Advisory: the index is archived exactly as staged -- no line dropping against the archive
    // set. A stale line (e.g. for a rejected topic) is cosmetic and fixed by the next rewrite.
    expect(indexCall![1]).toContain('topics/urlaub-planung.md - Familienurlaub - Alice, Bob');
    expect(indexCall![1]).toContain('abgelehntes-thema');
    expect(mockInsertNextVersion.mock.calls.some(call => call[0] === 'topics/urlaub-planung.md')).toBe(true);
    const paths = mockInsertNextVersion.mock.calls
      .map(call => call[0])
      .filter(p => p !== 'journals/alice/conv-1.md');
    expect(paths.indexOf('general/topic-index.md')).toBeGreaterThan(
      paths.indexOf('topics/urlaub-planung.md')
    );
    expect(result.status).toBe('completed');
  });

  it('topics load failure: run is partial, topics/ proposals skipped before review, advisory index archived as staged', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    // Phase 4's barrier load throws; every later listCurrentVersions call (Phases 5-7) stays healthy.
    mockListCurrentVersions
      .mockRejectedValueOnce(new Error('db boom listing current versions'))
      .mockImplementation(archive.listCurrentVersions);
    mockRunIntegrate.mockImplementationOnce(async (executeTool: any) => {
      await executeTool('stage_update', {
        path: 'topics/urlaub-planung.md',
        content: 'Aliases: Sommerreise',
        isNew: true
      });
      await executeTool('stage_update', {
        path: 'general/topic-index.md',
        content: 'topics/urlaub-planung.md - Familienurlaub - Alice, Bob',
        isNew: true
      });
      return { finalText: 'staged topic and index', iterations: 1 };
    });
    mockRunReview.mockResolvedValue({ approved: true, reason: 'ok' });
    const result = await runNightlyPipeline();
    // The load failure marks the run partial so the next invocation retries with healthy data.
    expect(result.status).toBe('partial');
    expect(mockSetWatermark).not.toHaveBeenCalled();
    // Without barrier data topics/ proposals are skipped BEFORE any review is spent on them --
    // no review call for the topic, and no archive call (it could be a duplicate).
    const topicReviewCall = mockRunReview.mock.calls.find(
      call => call[0]?.path === 'topics/urlaub-planung.md'
    );
    expect(topicReviewCall).toBeUndefined();
    expect(mockInsertNextVersion.mock.calls.some(call => call[0] === 'topics/urlaub-planung.md')).toBe(false);
    // The advisory index is archived as staged, without line-level validation.
    const indexCall = mockInsertNextVersion.mock.calls.find(call => call[0] === 'general/topic-index.md');
    expect(indexCall).toBeDefined();
    expect(indexCall![1]).toContain('urlaub-planung');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 10. Phase 7 privacy wiring
  // -------------------------------------------------------------------------
  it('Phase 7 strips [PRIVACY:SENSITIVE] blocks before compaction -- runCompact never sees sensitive content', async () => {
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

  // -------------------------------------------------------------------------
  // 11. Phase 7 empty-compaction guard
  // -------------------------------------------------------------------------
  it('Phase 7 skips the eager-cache upsert when compaction produces empty output, but does not fail the run', async () => {
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
  // 12. Phase 6 privacy wiring
  // -------------------------------------------------------------------------
  it('Phase 6 strips [PRIVACY:SENSITIVE] blocks before uploading to Mistral -- the local archive keeps the full content', async () => {
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
  // 13. Dream phase (4.5)
  // -------------------------------------------------------------------------
  it('dream: generates + archives the dream, appends the dated reflection, uploads both', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockShouldDreamTonight.mockReturnValue(true);
    mockSelectDreamSources.mockReturnValue([
      {
        id: 1,
        filePath: 'journals/alice/conv-1.md',
        content: 'journal A',
        contentHash: 'a',
        version: 1,
        mistralDocId: null,
        syncedAt: null,
        createdAt: new Date()
      },
      {
        id: 2,
        filePath: 'journals/bob/conv-2.md',
        content: 'journal B',
        contentHash: 'b',
        version: 1,
        mistralDocId: null,
        syncedAt: null,
        createdAt: new Date()
      }
    ]);
    mockRunDream.mockResolvedValueOnce('Ein seltsamer Traum vom Meer.');
    const result = await runNightlyPipeline();
    expect(result.dreamGenerated).toBe(true);
    const dreamPath = mockInsertNextVersion.mock.calls.find(call =>
      call[0].startsWith('journals/dreams/')
    )![0];
    const reflectionPath = 'self-reflection/dreams.md';
    const dateStr = dreamPath.slice('journals/dreams/'.length, -'.md'.length);
    const archivedDream =
      'TRAUM -- nicht wirklich passiert. Am ' +
      dateStr +
      ' hatte Yasmin diesen Traum (nur ein Traum, erfunden aus alten Tagebucheintragen):\n\n' +
      'Ein seltsamer Traum vom Meer.';
    // Stage 1: dream archived under journals/dreams/<date>.md, WITH the unambiguous dream header
    expect(mockInsertNextVersion).toHaveBeenCalledWith(dreamPath, archivedDream, expect.any(Date));
    // Stage 2: reflection appended (dated) to self-reflection/dreams.md. The reflection runs
    // on the ARCHIVED dream (header included), exactly as findUnreflectedDream returns it.
    expect(mockRunDreamReflection).toHaveBeenCalledWith(archivedDream);
    const reflectionInsert = mockInsertNextVersion.mock.calls.find(call => call[0] === reflectionPath);
    expect(reflectionInsert).toBeDefined();
    expect(reflectionInsert![1]).toContain('## Traum vom');
    expect(reflectionInsert![1]).toContain('Ich fuhle mich davon beruhrt.');
    // Phase 6: the dream + reflection are uploaded to the RAG library like any archive file.
    // The RAG copy MUST carry the dream marker, so the live agent can never mistake dream
    // content for things that really happened.
    expect(mockReplaceDocument).toHaveBeenCalledWith(dreamPath, archivedDream, undefined);
    expect(result.status).toBe('completed');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('dream: cadence skips the dream (no runDream call, no reflection, run completes)', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockShouldDreamTonight.mockReturnValue(false);
    const result = await runNightlyPipeline();
    expect(mockRunDream).not.toHaveBeenCalled();
    expect(mockRunDreamReflection).not.toHaveBeenCalled();
    expect(mockInsertNextVersion.mock.calls.some(call => call[0].startsWith('journals/dreams/'))).toBe(false);
    expect(result.dreamGenerated).toBe(false);
    expect(result.status).toBe('completed');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('dream: too few old journals (fewer than 2 sources) skips the dream without failing the run', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockShouldDreamTonight.mockReturnValue(true);
    mockSelectDreamSources.mockReturnValue([]);
    const result = await runNightlyPipeline();
    expect(mockRunDream).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('dream resume: crash after dream generation -- the dream is kept, only the reflection is caught up, no double dream', async () => {
    // The pipeline uses collectedAt = orphan.startedAt for the dream path, so the seeded dream MUST
    // be built from the SAME instant -- using `new Date()` here would drift across a UTC-date
    // boundary whenever the test runs near midnight (the original timezone flake).
    const orphanStartedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const orphan: NightlyJobLog = {
      id: 78,
      startedAt: orphanStartedAt,
      completedAt: null,
      status: 'running',
      lastCompletedPhase: '4-archive',
      processedConversationIds: ['conv-9'],
      skippedConversationIds: [],
      errorMessage: null,
      conversationsProcessed: 0,
      filesUpdated: 0,
      filesCreated: 0
    };
    mockFindRunningJob.mockResolvedValueOnce(orphan);
    mockListConversations.mockResolvedValueOnce([conversation('conv-9', 'Alice')]);
    // The crashed run had already durably archived the dream for its collection date.
    const dreamPath = dreamFilePath(orphanStartedAt);
    await archive.seed(dreamPath, 'Der Traum aus der letzten Nacht.');
    const result = await runNightlyPipeline();
    expect(result.dreamGenerated).toBe(true);
    // No second dream for a date that already has one.
    expect(mockRunDream).not.toHaveBeenCalled();
    // The reflection that the crash swallowed is caught up.
    expect(mockRunDreamReflection).toHaveBeenCalledWith('Der Traum aus der letzten Nacht.');
    const reflectionInsert = mockInsertNextVersion.mock.calls.find(
      call => call[0] === 'self-reflection/dreams.md'
    );
    expect(reflectionInsert).toBeDefined();
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('dream resume: an existing dated reflection is never duplicated', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockShouldDreamTonight.mockReturnValue(true);
    mockSelectDreamSources.mockReturnValue([
      {
        id: 1,
        filePath: 'journals/alice/conv-1.md',
        content: 'journal A',
        contentHash: 'a',
        version: 1,
        mistralDocId: null,
        syncedAt: null,
        createdAt: new Date()
      },
      {
        id: 2,
        filePath: 'journals/bob/conv-2.md',
        content: 'journal B',
        contentHash: 'b',
        version: 1,
        mistralDocId: null,
        syncedAt: null,
        createdAt: new Date()
      }
    ]);
    mockRunDream.mockResolvedValueOnce('Ein Traum.');
    // The seeded header and the pipeline's internal collectedAt must derive from ONE instant: a
    // real-clock dreamFilePath(new Date()) here could straddle a UTC-date rollover before the
    // pipeline's own new Date() (the same flake class the sibling resume test pins via
    // orphan.startedAt), making the seeded header match the wrong date.
    jest.useFakeTimers({ now: new Date('2026-10-09T12:00:00Z') });
    try {
      const dreamPath = dreamFilePath(new Date());
      const dateStr = dreamPath.slice('journals/dreams/'.length, -'.md'.length);
      await archive.seed('self-reflection/dreams.md', '## Traum vom ' + dateStr + '\n\nBereits reflektiert.');
      await runNightlyPipeline();
    } finally {
      jest.useRealTimers();
    }
    expect(mockRunDreamReflection).not.toHaveBeenCalled();
    const reflectionContent = await archive.getCurrentVersion('self-reflection/dreams.md');
    expect(reflectionContent?.content).not.toContain('Ich fuhle mich davon beruhrt.');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('dream: a failed stage-2 reflection keeps the dream, marks the run partial, and is retried by a later run', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockShouldDreamTonight.mockReturnValue(true);
    mockSelectDreamSources.mockReturnValue([
      {
        id: 1,
        filePath: 'journals/alice/conv-1.md',
        content: 'journal A',
        contentHash: 'a',
        version: 1,
        mistralDocId: null,
        syncedAt: null,
        createdAt: new Date()
      },
      {
        id: 2,
        filePath: 'journals/bob/conv-2.md',
        content: 'journal B',
        contentHash: 'b',
        version: 1,
        mistralDocId: null,
        syncedAt: null,
        createdAt: new Date()
      }
    ]);
    mockRunDream.mockResolvedValueOnce('Ein Traum vom Meer.');
    mockRunDreamReflection.mockRejectedValueOnce(new Error('persona agent down'));
    const result = await runNightlyPipeline();
    // The dream itself is durably kept (with its dream-marker header) ...
    const dreamPath = mockInsertNextVersion.mock.calls.find(call =>
      call[0].startsWith('journals/dreams/')
    )![0];
    const kept = await archive.getCurrentVersion(dreamPath);
    expect(kept?.content).toContain('TRAUM -- nicht wirklich passiert');
    expect(kept?.content).toContain('Ein Traum vom Meer.');
    // ... the run ends partial ...
    expect(result.status).toBe('partial');
    expect(mockSetWatermark).not.toHaveBeenCalled();

    // A LATER run (fresh job, new date, no cadence dream) must catch up the missing reflection:
    // 'partial' runs are not resumed, so this catch-up is the only retry stage 2 ever gets. The
    // later run needs at least one conversation, otherwise the pipeline exits at Phase 1 before
    // the dream phase ever runs.
    mockListConversations.mockResolvedValueOnce([conversation('conv-2', 'Bob')]);
    mockShouldDreamTonight.mockReturnValue(false);
    mockRunDreamReflection.mockResolvedValueOnce('Nachtraglich reflektiert.');
    const result2 = await runNightlyPipeline();
    expect(mockRunDream).toHaveBeenCalledTimes(1); // no new dream in the later run
    const keptContent = kept?.content ?? '';
    expect(mockRunDreamReflection).toHaveBeenCalledWith(keptContent); // archived dream incl. header
    const reflectionInsert = mockInsertNextVersion.mock.calls.find(
      call => call[0] === 'self-reflection/dreams.md'
    );
    expect(reflectionInsert).toBeDefined();
    expect(reflectionInsert![1]).toContain('Nachtraglich reflektiert.');
    expect(result2.status).toBe('completed');
    expect(mockReleaseLock).toHaveBeenCalledTimes(2);
  });

  it('dream: a failed dream generation marks the run partial without aborting it', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockShouldDreamTonight.mockReturnValue(true);
    mockSelectDreamSources.mockReturnValue([
      {
        id: 1,
        filePath: 'journals/alice/conv-1.md',
        content: 'journal A',
        contentHash: 'a',
        version: 1,
        mistralDocId: null,
        syncedAt: null,
        createdAt: new Date()
      },
      {
        id: 2,
        filePath: 'journals/bob/conv-2.md',
        content: 'journal B',
        contentHash: 'b',
        version: 1,
        mistralDocId: null,
        syncedAt: null,
        createdAt: new Date()
      }
    ]);
    mockRunDream.mockRejectedValueOnce(new Error('dream agent down'));
    const result = await runNightlyPipeline();
    expect(result.status).toBe('partial');
    // The rest of the run still completed: conversations were journaled and cleaned up.
    expect(mockInsertNextVersion).toHaveBeenCalledWith(
      'journals/alice/conv-1.md',
      'journal text',
      expect.any(Date)
    );
    expect(mockDeleteConversation).toHaveBeenCalledWith('conv-1');
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);
  });

  it('dream privacy: the dream agent never sees sensitive journal content in its prompt', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockShouldDreamTonight.mockReturnValue(true);
    mockSelectDreamSources.mockReturnValue([
      {
        id: 1,
        filePath: 'journals/alice/conv-1.md',
        content: "Alice's day.\n[PRIVACY:SENSITIVE]\nAlice secretly cried.\n[/PRIVACY:SENSITIVE]",
        contentHash: 'a',
        version: 1,
        mistralDocId: null,
        syncedAt: null,
        createdAt: new Date()
      },
      {
        id: 2,
        filePath: 'journals/bob/conv-2.md',
        content: 'journal B',
        contentHash: 'b',
        version: 1,
        mistralDocId: null,
        syncedAt: null,
        createdAt: new Date()
      }
    ]);
    await runNightlyPipeline();
    expect(mockRunDream).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ filePath: 'journals/alice/conv-1.md' })])
    );
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
      0,
      [],
      []
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
    mockGetIntradayNotesMaxId.mockResolvedValueOnce(5);
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
    expect(mockClearIntradayNotes).toHaveBeenCalledTimes(1);
  });

  it('outbox: is emptied on a merely partial run (failed upload) because consolidation succeeded', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockRunJournal.mockImplementation(async (userName: string) => 'Journal about ' + userName);
    mockRunIntegrate.mockResolvedValueOnce({ finalText: 'nothing to stage', iterations: 1 });
    mockGetIntradayNotesMaxId.mockResolvedValueOnce(9);
    mockListUnsynced.mockImplementationOnce(() => {
      throw new Error('db read failed');
    });
    const result = await runNightlyPipeline();
    expect(result.status).toBe('partial');
    expect(mockClearIntradayNotes).toHaveBeenCalledTimes(1);
    expect(mockClearIntradayNotes).toHaveBeenCalledWith(9);
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
    expect(mockClearIntradayNotes).not.toHaveBeenCalled();
  });

  it('outbox: a failed note read does not fail the run, and the outbox is NOT cleared (notes stay for tomorrow)', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockRunJournal.mockImplementation(async (userName: string) => 'Journal about ' + userName);
    mockRunIntegrate.mockResolvedValueOnce({ finalText: 'nothing to stage', iterations: 1 });
    mockGetUnconsolidatedNotes.mockRejectedValueOnce(new Error('db down'));
    const result = await runNightlyPipeline();
    expect(result.status).toBe('completed');
    expect(mockRunIntegrate).toHaveBeenCalledWith(expect.any(Function), []);
    expect(mockClearIntradayNotes).not.toHaveBeenCalled();
  });

  it('outbox: is NOT emptied when the integrate loop hit maxIterations (notes may be unconsolidated)', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockRunJournal.mockImplementation(async (userName: string) => 'Journal about ' + userName);
    mockRunIntegrate.mockResolvedValueOnce({ finalText: 'staged', iterations: 25 });
    const result = await runNightlyPipeline();
    // integrateTruncated itself already degrades the run to 'partial'
    expect(result.status).toBe('partial');
    expect(mockClearIntradayNotes).not.toHaveBeenCalled();
  });

  it('outbox: clearing deletes up to the MAX(id) over ALL notes, so a delivered-only outbox still empties', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockRunJournal.mockImplementation(async (userName: string) => 'Journal about ' + userName);
    mockRunIntegrate.mockResolvedValueOnce({ finalText: 'nothing to stage', iterations: 1 });
    // All notes already delivered individually: undelivered set is empty, but the table still
    // holds rows -- the watermark must come from MAX(id), not from the undelivered subset.
    mockGetIntradayNotesMaxId.mockResolvedValueOnce(23);
    mockGetUnconsolidatedNotes.mockResolvedValueOnce([]);
    const result = await runNightlyPipeline();
    expect(result.status).toBe('completed');
    expect(mockClearIntradayNotes).toHaveBeenCalledTimes(1);
    expect(mockClearIntradayNotes).toHaveBeenCalledWith(23);
  });

  it('outbox: skips the DELETE entirely when the table is empty (no pointless clear)', async () => {
    mockListConversations.mockResolvedValueOnce([conversation('conv-1', 'Alice')]);
    mockRunJournal.mockImplementation(async (userName: string) => 'Journal about ' + userName);
    mockRunIntegrate.mockResolvedValueOnce({ finalText: 'nothing to stage', iterations: 1 });
    mockGetIntradayNotesMaxId.mockResolvedValueOnce(0);
    const result = await runNightlyPipeline();
    expect(result.status).toBe('completed');
    expect(mockClearIntradayNotes).not.toHaveBeenCalled();
  });
});
