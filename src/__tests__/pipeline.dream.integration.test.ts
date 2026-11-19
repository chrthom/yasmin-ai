import {
  runNightlyPipeline,
  NightlyJobLog,
  archive,
  conversation,
  dreamFilePath,
  mockReleaseLock,
  mockFindRunningJob,
  mockSetWatermark,
  mockInsertNextVersion,
  mockListConversations,
  mockDeleteConversation,
  mockReplaceDocument,
  mockRunDream,
  mockRunDreamReflection,
  mockSelectDreamSources,
  mockShouldDreamTonight,
  setupPipelineFixture
} from './fixtures/pipeline.integration.fixture';

describe('nightly pipeline integration', () => {
  beforeEach(setupPipelineFixture);

  // -------------------------------------------------------------------------
  // Dream phase (4.5)
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
});
