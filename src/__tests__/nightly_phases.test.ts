jest.mock('../config', () => ({
  config: {
    nightly: { maxRevisions: 1, eagerMaxChars: 4000 },
    context: { profileOfYasminTitle: 'Profile of Yasmin', familyNotesTitle: 'Family notes' }
  }
}));
jest.mock('../database/models/context.model', () => ({ upsertContextEntry: jest.fn() }));
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
jest.mock('../nightly/reflection', () => ({
  runReview: jest.fn(),
  reviseProposal: jest.fn(),
  runCompact: jest.fn()
}));
jest.mock('../nightly/dream', () => ({
  ...jest.requireActual('../nightly/dream'),
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
import { upsertContextEntry } from '../database/models/context.model';
import { updateJobLog } from '../database/models/nightly_job.model';
import { deleteConversation, deleteDocument, listDocuments, replaceDocument } from '../mistral/mistral_api';
import {
  appendDreamReflection,
  dreamDateFromPath,
  dreamFilePath,
  runDream,
  runDreamReflection,
  findUnreflectedDream,
  selectDreamSources,
  shouldDreamTonight
} from '../nightly/dream';
import { runDreamPhase } from '../nightly/dream_phase';
import { runEagerPhase } from '../nightly/eager_phase';
import { reviseProposal, runCompact, runReview } from '../nightly/reflection';
import { runReviewPhase } from '../nightly/review_phase';
import { runUploadPhase } from '../nightly/upload_phase';

const collectedAt = new Date('2026-01-02T12:00:00Z');

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

test('dream generates a self-describing archive, appends reflection and stamps only after both writes', async () => {
  const path = 'journals/dreams/2026-01-02.md';
  const sources = [{ content: 'old journal one' }, { content: 'old journal two' }];
  (dreamFilePath as jest.Mock).mockReturnValue(path);
  (dreamDateFromPath as jest.Mock).mockReturnValue('2026-01-02');
  (listCurrentVersions as jest.Mock).mockResolvedValue([]);
  (getCurrentVersion as jest.Mock).mockResolvedValue(null);
  (shouldDreamTonight as jest.Mock).mockReturnValue(true);
  (selectDreamSources as jest.Mock).mockReturnValue(sources);
  (runDream as jest.Mock).mockResolvedValue('Flying through the kitchen.');
  (findUnreflectedDream as jest.Mock).mockReturnValue({ filePath: path, content: 'archived dream' });
  (runDreamReflection as jest.Mock).mockResolvedValue('My reflection.');
  (appendDreamReflection as jest.Mock).mockReturnValue('dated reflection');

  await expect(runDreamPhase(7, collectedAt)).resolves.toEqual({
    dreamGenerated: true,
    anyDreamFailed: false
  });
  expect(runDream).toHaveBeenCalledWith(sources);
  expect(insertNextVersion).toHaveBeenNthCalledWith(
    1,
    path,
    'TRAUM -- nicht wirklich passiert. Am 2026-01-02 hatte Yasmin diesen Traum ' +
      '(nur ein Traum, erfunden aus alten Tagebucheintragen):\n\nFlying through the kitchen.',
    collectedAt
  );
  expect(runDreamReflection).toHaveBeenCalledWith('archived dream');
  expect(appendDreamReflection).toHaveBeenCalledWith(null, '2026-01-02', 'My reflection.');
  expect(insertNextVersion).toHaveBeenNthCalledWith(
    2,
    'self-reflection/dreams.md',
    'dated reflection',
    collectedAt
  );
  expect(updateJobLog).toHaveBeenCalledWith(7, { lastCompletedPhase: '5-dream' });
  expect((insertNextVersion as jest.Mock).mock.invocationCallOrder[1]).toBeLessThan(
    (updateJobLog as jest.Mock).mock.invocationCallOrder[0]
  );
});

test('review revises with note evidence, archives approved files and reviews the topic index last', async () => {
  const oldTopic = { filePath: 'topics/old.md', content: 'old topic' };
  const topic = { path: 'topics/new.md', content: 'new topic', isNew: true };
  const profile = { path: 'people/alice.md', content: 'proposal', isNew: true };
  const index = { path: 'general/topic-index.md', content: 'index', isNew: true };
  const notes = [{ id: 5 }] as Parameters<typeof runReviewPhase>[2];
  (listCurrentVersions as jest.Mock).mockResolvedValue([oldTopic]);
  (getCurrentVersion as jest.Mock).mockImplementation(async (path: string) =>
    path === profile.path ? { content: 'old profile', createdAt: collectedAt } : null
  );
  (runReview as jest.Mock)
    .mockResolvedValueOnce({ approved: true })
    .mockResolvedValueOnce({ approved: false, reason: 'needs evidence' })
    .mockResolvedValue({ approved: true });
  (reviseProposal as jest.Mock).mockResolvedValue({ content: 'revised', conversationId: 'scratch' });
  (insertNextVersion as jest.Mock).mockResolvedValue({ created: true });

  await expect(runReviewPhase([index, topic, profile], [], notes, collectedAt)).resolves.toEqual({
    filesUpdated: 1,
    filesCreated: 2,
    anyReviewFailed: false,
    notesConsolidated: true
  });
  expect(runReview).toHaveBeenNthCalledWith(
    1,
    topic,
    null,
    null,
    [],
    0,
    [{ path: oldTopic.filePath, content: oldTopic.content }],
    notes
  );
  expect(reviseProposal).toHaveBeenCalledWith(
    profile,
    'old profile',
    'proposal',
    'needs evidence',
    [],
    undefined,
    notes
  );
  expect(runReview).toHaveBeenNthCalledWith(
    3,
    { ...profile, content: 'revised' },
    'old profile',
    collectedAt.toISOString(),
    [],
    1,
    [
      { path: oldTopic.filePath, content: oldTopic.content },
      { path: topic.path, content: topic.content }
    ],
    notes
  );
  expect(deleteConversation).toHaveBeenCalledWith('scratch');
  expect(insertNextVersion).toHaveBeenCalledWith(profile.path, 'revised', collectedAt);
  expect((runReview as jest.Mock).mock.calls[3][0]).toEqual(index);
});

test('eager compacts mapped entries and folds stripped mood/dream evidence into Yasmin only', async () => {
  const sensitive = '\n[PRIVACY:SENSITIVE]\nprivate secret\n[/PRIVACY:SENSITIVE]';
  (listCurrentVersions as jest.Mock).mockResolvedValue([
    { filePath: 'self-reflection/profile.md', content: 'Yasmin profile' + sensitive },
    { filePath: 'people/alice.md', content: 'Alice profile' + sensitive },
    { filePath: 'general/family.md', content: 'Family profile' + sensitive },
    { filePath: 'topics/one.md', content: 'RAG only' }
  ]);
  (getCurrentVersion as jest.Mock).mockImplementation(async (path: string) => ({
    content:
      path === 'self-reflection/mood.md'
        ? 'valence: 0.8\nenergy: 0.6\nhalfLifeDays: 1\nupdatedAt: 2026-01-02T12:00:00Z\n\nHappy mood' +
          sensitive
        : '## Traum vom 2026-01-02\n\nDream self-concept' + sensitive
  }));
  (runCompact as jest.Mock).mockResolvedValue('safe compacted profile');

  await expect(runEagerPhase()).resolves.toBe(false);
  expect(runCompact).toHaveBeenCalledTimes(3);
  const yasminSource = (runCompact as jest.Mock).mock.calls[0][2];
  expect(yasminSource).toContain('Yasmin profile');
  expect(yasminSource).toContain('Happy mood');
  expect(yasminSource).toContain('Dream self-concept');
  expect(runCompact).toHaveBeenNthCalledWith(1, 'yasmin', undefined, yasminSource);
  expect(runCompact).toHaveBeenNthCalledWith(2, 'person', 'Alice', 'Alice profile\n');
  expect(runCompact).toHaveBeenNthCalledWith(3, 'family', undefined, 'Family profile\n');
  for (const call of (runCompact as jest.Mock).mock.calls) {
    expect(call[2]).not.toContain('private secret');
    expect(call[2]).not.toContain('PRIVACY:SENSITIVE');
  }
  expect(upsertContextEntry).toHaveBeenCalledTimes(3);
  for (const title of ['Profile of Yasmin', 'Profile of Alice', 'Family notes']) {
    expect(upsertContextEntry).toHaveBeenCalledWith(title, 'safe compacted profile');
  }
});

test('upload strips private content, skips empty files and removes only orphan/duplicate copies', async () => {
  (listUnsynced as jest.Mock).mockResolvedValue([
    {
      id: 1,
      filePath: 'people/alice.md',
      content: 'public\n[PRIVACY:SENSITIVE]\nsecret\n[/PRIVACY:SENSITIVE]',
      mistralDocId: 'old-doc'
    },
    { id: 2, filePath: 'empty.md', content: '   ' }
  ]);
  (replaceDocument as jest.Mock).mockResolvedValue({ id: 'new-doc' });
  (listCurrentVersions as jest.Mock).mockResolvedValue([
    { filePath: 'people/alice.md', mistralDocId: 'new-doc' }
  ]);
  (listDocuments as jest.Mock).mockResolvedValue([
    { path: 'people/alice.md', id: 'old-doc' },
    { path: 'people/alice.md', id: 'new-doc' },
    { path: 'orphan.md', id: 'orphan' }
  ]);

  await expect(runUploadPhase()).resolves.toEqual({ anyUploadFailed: false, anyDeleteFailed: false });
  expect(replaceDocument).toHaveBeenCalledTimes(1);
  expect(replaceDocument).toHaveBeenCalledWith('people/alice.md', 'public\n', 'old-doc');
  expect(markSynced).toHaveBeenCalledTimes(1);
  expect(markSynced).toHaveBeenCalledWith(1, 'new-doc');
  expect(deleteDocument).toHaveBeenCalledTimes(2);
  expect(deleteDocument).toHaveBeenCalledWith('old-doc');
  expect(deleteDocument).toHaveBeenCalledWith('orphan');
  expect(deleteDocument).not.toHaveBeenCalledWith('new-doc');
});

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
    // Deliberately pins pre-extraction behavior: Phase 8 can clear note-derived topic evidence.
    // Issue #146 must change this assertion together with the outbox-preservation regression.
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
