import {
  runNightlyPipeline,
  archive,
  conversation,
  mockReleaseLock,
  mockGetCurrentVersion,
  mockListUnsynced,
  mockUpsertContextEntry,
  mockGetIntradayNotesMaxId,
  mockGetUnconsolidatedNotes,
  mockClearIntradayNotes,
  mockRunJournal,
  mockRunIntegrate,
  mockRunReview,
  mockRunCompact,
  mockListConversations,
  setupPipelineFixture
} from './fixtures/pipeline.integration.fixture';

describe('nightly pipeline integration', () => {
  beforeEach(setupPipelineFixture);

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
