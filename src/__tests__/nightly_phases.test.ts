jest.mock('../config', () => ({ config: { nightly: { maxRevisions: 1 } } }));
jest.mock('../database/models/memory_archive.model', () => ({
  getCurrentVersion: jest.fn(),
  insertNextVersion: jest.fn(),
  listCurrentVersions: jest.fn(),
  listUnsynced: jest.fn(),
  markSynced: jest.fn()
}));
jest.mock('../database/models/nightly_job.model', () => ({ updateJobLog: jest.fn() }));
jest.mock('../mistral/mistral_api', () => ({
  deleteConversation: jest.fn(),
  deleteDocument: jest.fn(),
  listDocuments: jest.fn(),
  replaceDocument: jest.fn()
}));
jest.mock('../nightly/reflection', () => ({ runReview: jest.fn(), reviseProposal: jest.fn() }));
jest.mock('../nightly/dream', () => ({
  DREAM_REFLECTION_PATH: 'self-reflection/dreams.md',
  dreamFilePath: jest.fn(() => 'journals/dreams/2026-01-02.md'),
  findUnreflectedDream: jest.fn(),
  findLastDreamAt: jest.fn(),
  shouldDreamTonight: jest.fn(),
  selectDreamSources: jest.fn(),
  runDream: jest.fn(),
  runDreamReflection: jest.fn(),
  appendDreamReflection: jest.fn(),
  dreamDateFromPath: jest.fn()
}));

import {
  getCurrentVersion,
  insertNextVersion,
  listCurrentVersions,
  listUnsynced,
  markSynced
} from '../database/models/memory_archive.model';
import { updateJobLog } from '../database/models/nightly_job.model';
import { deleteDocument, listDocuments, replaceDocument } from '../mistral/mistral_api';
import { dreamFilePath, runDream, findUnreflectedDream } from '../nightly/dream';
import { runDreamPhase } from '../nightly/dream_phase';
import { runReview } from '../nightly/reflection';
import { runReviewPhase } from '../nightly/review_phase';
import { runUploadPhase } from '../nightly/upload_phase';

const collectedAt = new Date('2026-01-02T12:00:00Z');

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

test('dream stamp failure reports partial while retaining the already generated dream flag', async () => {
  (dreamFilePath as jest.Mock).mockReturnValue('journals/dreams/2026-01-02.md');
  (listCurrentVersions as jest.Mock).mockResolvedValue([]);
  (getCurrentVersion as jest.Mock).mockImplementation(async (path: string) =>
    path.startsWith('journals/dreams/') ? { content: 'existing dream' } : null
  );
  (findUnreflectedDream as jest.Mock).mockReturnValue(null);
  (updateJobLog as jest.Mock).mockRejectedValue(new Error('log unavailable'));

  await expect(runDreamPhase(7, collectedAt)).resolves.toEqual({
    dreamGenerated: true,
    anyDreamFailed: true
  });
  expect(runDream).not.toHaveBeenCalled();
  expect(updateJobLog).toHaveBeenCalledWith(7, { lastCompletedPhase: '5-dream' });
});

test('topic barrier load failure drops topics but retains the existing note-clear decision', async () => {
  (listCurrentVersions as jest.Mock).mockRejectedValue(new Error('archive unavailable'));
  (getCurrentVersion as jest.Mock).mockResolvedValue(null);
  (runReview as jest.Mock).mockResolvedValue({ approved: true });
  (insertNextVersion as jest.Mock).mockResolvedValue({ created: true });
  const notes = [{ id: 5 }] as Parameters<typeof runReviewPhase>[2];

  const result = await runReviewPhase(
    [
      { path: 'topics/one.md', content: 'topic', isNew: true },
      { path: 'people/alice.md', content: 'profile', isNew: true }
    ],
    [],
    notes,
    collectedAt
  );

  expect(result).toEqual({
    filesUpdated: 0,
    filesCreated: 1,
    anyReviewFailed: true,
    notesConsolidated: true
  });
  expect(runReview).toHaveBeenCalledTimes(1);
  expect(runReview).toHaveBeenCalledWith(
    expect.objectContaining({ path: 'people/alice.md' }),
    null,
    null,
    [],
    0,
    [],
    notes
  );
  expect(insertNextVersion).toHaveBeenCalledWith('people/alice.md', 'profile', collectedAt);
});

test('upload marks a replacement synced before reconciliation and reports a failed orphan deletion', async () => {
  (listUnsynced as jest.Mock).mockResolvedValue([{ id: 1, filePath: 'people/alice.md', content: 'public' }]);
  (replaceDocument as jest.Mock).mockResolvedValue({ id: 'new-doc' });
  (listCurrentVersions as jest.Mock).mockResolvedValue([
    { filePath: 'people/alice.md', mistralDocId: 'new-doc' }
  ]);
  (listDocuments as jest.Mock).mockResolvedValue([{ path: 'orphan.md', id: 'orphan' }]);
  (deleteDocument as jest.Mock).mockRejectedValue(new Error('delete failed'));

  await expect(runUploadPhase()).resolves.toEqual({ anyUploadFailed: false, anyDeleteFailed: true });
  expect(markSynced).toHaveBeenCalledWith(1, 'new-doc');
  expect((markSynced as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
    (listCurrentVersions as jest.Mock).mock.invocationCallOrder[0]
  );
  expect(deleteDocument).toHaveBeenCalledWith('orphan');
});
