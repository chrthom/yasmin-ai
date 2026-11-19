// Integration tests for the nightly pipeline orchestration (src/nightly/pipeline.ts).
//
// Mocking strategy:
// - '../../nightly/reflection' is mocked directly (not the real reflection.ts + a mocked mistral_api) so
//   these tests assert pipeline.ts's ORCHESTRATION logic, not reflection.ts's prompt wording.
// - '../../database/models/memory_archive.model' is backed by a small in-memory fake (MemoryArchiveFake)
//   that mirrors the real module's hash-based no-churn versioning, so multi-call interactions (the
//   journal loop reading back what it just wrote, phase 4's review + archive, phase 6/7 reconcile) are
//   genuinely exercised rather than hand-chained with mockResolvedValueOnce.
// - '../../database/models/nightly_job.model' and '../../database/models/context.model' are coarse per-call
//   jest.fn mocks -- their own real behavior is covered by dedicated model unit tests already.
// - '../../nightly/tools' is the REAL module -- it is simple in-process state that pipeline.ts genuinely
//   depends on, and using the real module makes the phase-3/4 staged-update flow realistic.

import { createHash } from 'node:crypto';

jest.mock('../../config', () => ({
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

jest.mock('../../database/models/nightly_job.model', () => ({
  createJobLog: jest.fn(),
  updateJobLog: jest.fn(),
  getWatermark: jest.fn(),
  pruneOldJobLogs: jest.fn(),
  acquireLock: jest.fn(),
  releaseLock: jest.fn(),
  findRunningJob: jest.fn(),
  setWatermark: jest.fn()
}));

jest.mock('../../database/models/memory_archive.model', () => ({
  getCurrentVersion: jest.fn(),
  insertNextVersion: jest.fn(),
  listCurrentVersions: jest.fn(),
  listUnsynced: jest.fn(),
  markSynced: jest.fn(),
  pruneOldVersions: jest.fn()
}));

jest.mock('../../database/models/context.model', () => ({
  upsertContextEntry: jest.fn()
}));
jest.mock('../../database/models/intraday_notes.model', () => ({
  getIntradayNotesMaxId: jest.fn(),
  getUnconsolidatedNotes: jest.fn(),
  clearIntradayNotes: jest.fn()
}));

jest.mock('../../nightly/reflection', () => ({
  buildTranscript: jest.fn(),
  runJournal: jest.fn(),
  runIntegrate: jest.fn(),
  runReview: jest.fn(),
  reviseProposal: jest.fn(),
  runCompact: jest.fn()
}));

jest.mock('../../nightly/dream', () => {
  // The soft-evidence extraction (recentDreamReflections) is exercised through the REAL
  // implementation -- the fold-in tests assert its actual trimming behavior -- while the
  // agent-calling and cadence functions stay mocked to keep Phase 5 controllable.
  const actualDream = jest.requireActual('../../nightly/dream');
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
jest.mock('../../mistral/mistral_api', () => ({
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

import { LockHeldError, runNightlyPipeline } from '../../nightly/pipeline';
import { parseMood } from '../../nightly/mood';
import { resetNightlyToolsState } from '../../nightly/tools';
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
} from '../../database/models/nightly_job.model';
import {
  getCurrentVersion,
  insertNextVersion,
  listCurrentVersions,
  listUnsynced,
  markSynced,
  pruneOldVersions
} from '../../database/models/memory_archive.model';
import { upsertContextEntry } from '../../database/models/context.model';
import {
  clearIntradayNotes,
  getIntradayNotesMaxId,
  getUnconsolidatedNotes
} from '../../database/models/intraday_notes.model';
import {
  buildTranscript,
  runCompact,
  runIntegrate,
  runJournal,
  runReview,
  reviseProposal
} from '../../nightly/reflection';
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
} from '../../nightly/dream';
import {
  deleteConversation,
  deleteDocument,
  getConversationMessages,
  listConversations,
  listDocuments,
  replaceDocument
} from '../../mistral/mistral_api';

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

export function setupPipelineFixture(): void {
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
}

export {
  LockHeldError,
  runNightlyPipeline,
  parseMood,
  NightlyJobLog,
  archive,
  conversation,
  dreamFilePath,
  FAMILY_AGENT_ID,
  mockCreateJobLog,
  mockUpdateJobLog,
  mockGetWatermark,
  mockPruneOldJobLogs,
  mockAcquireLock,
  mockReleaseLock,
  mockFindRunningJob,
  mockSetWatermark,
  mockGetCurrentVersion,
  mockInsertNextVersion,
  mockListCurrentVersions,
  mockListUnsynced,
  mockMarkSynced,
  mockPruneOldVersions,
  mockUpsertContextEntry,
  mockGetIntradayNotesMaxId,
  mockGetUnconsolidatedNotes,
  mockClearIntradayNotes,
  mockBuildTranscript,
  mockRunJournal,
  mockRunIntegrate,
  mockRunReview,
  mockReviseProposal,
  mockRunCompact,
  mockListConversations,
  mockGetConversationMessages,
  mockDeleteConversation,
  mockListDocuments,
  mockReplaceDocument,
  mockDeleteDocument,
  mockFindLastDreamAt,
  mockRunDream,
  mockRunDreamReflection,
  mockSelectDreamSources,
  mockShouldDreamTonight
};
