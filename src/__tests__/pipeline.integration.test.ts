import {
  LockHeldError,
  runNightlyPipeline,
  NightlyJobLog,
  archive,
  conversation,
  mockCreateJobLog,
  mockUpdateJobLog,
  mockGetWatermark,
  mockPruneOldJobLogs,
  mockAcquireLock,
  mockReleaseLock,
  mockFindRunningJob,
  mockSetWatermark,
  mockInsertNextVersion,
  mockListCurrentVersions,
  mockListUnsynced,
  mockMarkSynced,
  mockPruneOldVersions,
  mockUpsertContextEntry,
  mockGetIntradayNotesMaxId,
  mockGetUnconsolidatedNotes,
  mockClearIntradayNotes,
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
  setupPipelineFixture
} from './fixtures/pipeline.integration.fixture';

describe('nightly pipeline integration', () => {
  beforeEach(setupPipelineFixture);

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
});
