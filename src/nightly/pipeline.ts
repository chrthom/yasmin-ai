import { hostname } from 'node:os';
import { config } from '../config';
import {
  NightlyJobStatus,
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
  pruneOldVersions
} from '../database/models/memory_archive.model';
import {
  clearIntradayNotes,
  getIntradayNotesMaxId,
  getUnconsolidatedNotes,
  IntradayNote
} from '../database/models/intraday_notes.model';
import {
  JournalEntry,
  StagedUpdate,
  get_long_term_file,
  getStagedUpdates,
  list_long_term_files,
  read_todays_journals,
  resetNightlyToolsState,
  setTodaysJournals,
  stage_update
} from './tools';
import { buildTranscript, runIntegrate, runJournal } from './reflection';
import { runDreamPhase } from './dream_phase';
import { runEagerPhase } from './eager_phase';
import { runReviewPhase } from './review_phase';
import { runUploadPhase } from './upload_phase';
import { sanitizeForPath } from '../strings';
import { decayMoodFile } from './mood';
import { deleteConversation, getConversationMessages, listConversations } from '../mistral/mistral_api';

/** Thrown when the nightly lock could not be acquired -- an expected outcome, not a failure to alert on */
export class LockHeldError extends Error {
  /**
   * Builds the error with the reason the nightly lock could not be acquired.
   *
   * @param message Why the lock could not be acquired (e.g. another active run).
   */
  constructor(message: string) {
    super(message);
    this.name = 'LockHeldError';
  }
}

/** Summary of one completed (or partially completed) nightly run, as persisted in nightly_job_log. */
export interface PipelineResult {
  jobId: number;
  status: NightlyJobStatus;
  conversationsProcessed: number;
  filesUpdated: number;
  filesCreated: number;
  dreamGenerated: boolean;
}

/**
 * Computes the ISO watermark to pass to listConversations, falling back to 24h ago when the stored
 * watermark is missing or (guarding against corruption/clock skew) more than 1 hour in the future
 *
 * @returns The ISO timestamp of the durable watermark, or the 24h-ago fallback.
 */
export async function computeSinceIso(): Promise<string> {
  const watermark = await getWatermark();
  const oneHourFromNowMs = Date.now() + 60 * 60 * 1000;
  const fallback = new Date(Date.now() - 24 * 60 * 60 * 1000);

  if (!watermark || watermark.getTime() > oneHourFromNowMs) {
    return fallback.toISOString();
  }

  return watermark.toISOString();
}

/**
 * Dispatches a nightly-tool call by name, JSON-stringifying whatever the underlying tool returns
 *
 * @param name The tool name the agent called.
 * @param args The parsed tool arguments.
 * @returns The tool's result as a JSON string (or an error object for unknown tools).
 */
async function executeIntegrateTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'list_long_term_files':
      return JSON.stringify(await list_long_term_files());
    case 'get_long_term_file':
      return JSON.stringify(await get_long_term_file(args['path'] as string));
    case 'read_todays_journals':
      return JSON.stringify(read_todays_journals());
    case 'stage_update':
      return JSON.stringify(
        stage_update(args['path'] as string, args['content'] as string, args['isNew'] === true)
      );
    default:
      return JSON.stringify({ error: 'unknown tool' });
  }
}

/**
 * Runs the full nightly memory-consolidation pipeline: collect, journal, integrate, review/archive,
 * upload, regenerate the eager cache, and clean up -- see docs/nightly_memory_processing_implementation.md
 *
 * @returns The run's summary (job id, status, counters).
 * @throws LockHeldError when another run holds the nightly processing lock.
 * @throws The underlying error when a phase fails non-recoverably (the job row is marked 'failed' first).
 */
export async function runNightlyPipeline(): Promise<PipelineResult> {
  const owner = hostname() + ':' + process.pid;
  const lockAcquired = await acquireLock('nightly', owner, config.nightly.lockStaleMs);
  if (!lockAcquired) {
    throw new LockHeldError('Another nightly run is already active');
  }

  let jobId: number | undefined;

  try {
    // -----------------------------------------------------------------------
    // Resume model + Phase 1 -- Collect
    // -----------------------------------------------------------------------
    const orphan = await findRunningJob();
    let conversations: { id: string; name: string }[];
    const skippedIds: string[] = [];
    // The watermark for the NEXT run must reflect when THIS run's Phase-1 snapshot was taken, not
    // when the job finishes minutes later -- otherwise conversations updated in that gap are
    // permanently invisible to every future run (see computeSinceIso/getWatermark).
    let collectedAt: Date;

    // Only a genuine resume if Phase 1 durably recorded its conversation batch: if the process
    // crashed between createJobLog() and that write, fall through to the fresh-collection path
    // (still reusing the orphan's row/id) rather than treating an empty id list as "nothing to process".
    if (orphan && orphan.processedConversationIds.length > 0) {
      jobId = orphan.id;
      resetNightlyToolsState();
      // The resumed batch replays the original run's conversations, so the watermark must reflect
      // when that batch was snapshotted -- startedAt is the closest proxy for the exact collection
      // instant. A watermark of "now" would drop conversations changed since the original snapshot.
      collectedAt = orphan.startedAt;

      // Recover usernames for the reused id list by re-listing with the same watermark-derived
      // sinceIso; the id list itself comes straight from the orphaned row (NOT re-derived) for
      // byte-identical reprocessing of the same batch.
      const sinceIso = await computeSinceIso();
      const listed = await listConversations(sinceIso);
      const listedById = new Map(listed.map(c => [c.id, c]));

      conversations = orphan.processedConversationIds.map(id => {
        const found = listedById.get(id);
        if (found) {
          return { id, name: found.name || id };
        }
        console.warn(
          'WARN Resumed conversation ' + id + ' not found in listing; using id as placeholder name'
        );
        return { id, name: id };
      });
    } else {
      jobId = orphan ? orphan.id : await createJobLog();
      resetNightlyToolsState();

      const sinceIso = await computeSinceIso();
      collectedAt = new Date();
      const allConversations = await listConversations(sinceIso);
      // Filter to the LIVE family chat agent's id -- NOT the nightly agent's id -- so the nightly
      // job's own scratch conversations (created below in phases 2-4) never get picked up as if
      // they were family conversations on a later run.
      const filtered = allConversations.filter(c => c.agentId === config.mistral.agentId);

      // The batch is persisted only when non-empty: an empty batch has nothing to resume and is
      // handled by the empty-batch short-circuit below, which completes the job row directly.
      if (filtered.length > 0) {
        await updateJobLog(jobId, {
          processedConversationIds: filtered.map(c => c.id),
          lastCompletedPhase: '1-collect'
        });
      }

      conversations = filtered.map(c => ({ id: c.id, name: c.name || c.id }));
    }

    // -----------------------------------------------------------------------
    // Pending-notes snapshot (evidence for Phase 3, bound for Phase 8)
    // -----------------------------------------------------------------------
    // Undelivered pending notes (the live agent's cross-person outbox) ride along as extra
    // evidence so a message that never reached its recipient still survives in long-term
    // memory. A failed read must not fail the run -- consolidation continues on journals alone.
    // This snapshot is deliberately taken right after Phase 1 (not later, inside Phase 3):
    // the empty-batch short-circuit below needs the outbox state to decide whether the run
    // really has nothing to do.
    let undeliveredNotes: IntradayNote[] = [];
    // Watermark of the consolidation snapshot: phase 8 may only delete notes up to this id,
    // never a note the live agent staged after the snapshot while the pipeline was running.
    // Taking the snapshot this early is the safe direction for that bound -- a note staged
    // later during the run is neither consolidated nor deleted, so it simply survives for the
    // next nightly run. The watermark is MAX(id) over ALL notes (delivered ones included), not
    // over the undelivered subset: with only delivered notes the undelivered max would be 0 and
    // the bounded DELETE would remove nothing, so the outbox would never empty and grow unbounded.
    let notesSnapshotMaxId = 0;
    let notesConsolidated = true;
    try {
      notesSnapshotMaxId = await getIntradayNotesMaxId();
      undeliveredNotes = await getUnconsolidatedNotes(notesSnapshotMaxId);
      if (undeliveredNotes.length > 0) {
        console.log(
          'INFO Feeding ' + undeliveredNotes.length + ' undelivered pending note(s) to the integrate agent'
        );
      }
    } catch (error) {
      // The notes themselves were never consolidated here, so phase 8 must NOT delete them;
      // they stay in the outbox and are included again tomorrow.
      console.error('ERROR Failed to load undelivered pending notes; continuing without them: ' + error);
      notesConsolidated = false;
    }

    // -----------------------------------------------------------------------
    // Empty-batch short-circuit (skip Phases 2-9 when there is nothing to do)
    // -----------------------------------------------------------------------
    // Applies to BOTH collect paths: a fresh run that found no conversations AND a resumed run
    // whose effective batch is empty (the resumed branch always replays a non-empty id list,
    // but the guard keeps that invariant enforced rather than accidental -- e.g. for the
    // crashed-before-the-batch-write orphan that falls through to fresh collection). The
    // undelivered-notes check is part of the skip condition: the outbox consolidation rides
    // along with Phases 3/4, so with pending notes there IS work only this job can do and the
    // run must continue (with zero conversations) to consolidate them. A failed notes read
    // also lands here -- the skip performs no outbox writes, so those notes are never lost;
    // they stay pending and are picked up by the next run.
    if (conversations.length === 0 && undeliveredNotes.length === 0) {
      await updateJobLog(jobId, {
        status: 'completed',
        completedAt: collectedAt,
        lastCompletedPhase: '1-collect',
        conversationsProcessed: 0
      });
      // The Phase-1 snapshot was taken and everything up to it has been seen, so the empty run
      // advances the watermark exactly like any completed run -- otherwise the window would
      // stay pinned to the last non-empty night forever.
      await setWatermark(collectedAt);
      // The outbox claim is only honest when the read succeeded: after a failed notes read the
      // outbox state is unknown (stderr already carries the error), so stdout must not say
      // 'no undelivered notes'.
      console.log(
        'INFO Nothing to process (no conversations, ' +
          (notesConsolidated ? 'no undelivered notes' : 'outbox state unknown (read failed)') +
          '); skipping phases 2-9'
      );
      return {
        jobId,
        status: 'completed',
        conversationsProcessed: 0,
        filesUpdated: 0,
        filesCreated: 0,
        dreamGenerated: false
      };
    }

    // -----------------------------------------------------------------------
    // Phase 2 -- Journal
    // -----------------------------------------------------------------------
    const todaysJournals: JournalEntry[] = [];

    for (const conv of conversations) {
      const journalPath = 'journals/' + sanitizeForPath(conv.name) + '/' + conv.id + '.md';
      const existing = await getCurrentVersion(journalPath);

      if (!existing) {
        let journalText: string;
        try {
          const messages = await getConversationMessages(conv.id);
          const transcript = buildTranscript(messages);
          const textPartCount = messages.reduce(
            (n, m) => n + (Array.isArray(m.content) ? m.content.filter(p => p?.type === 'text').length : 0),
            0
          );
          console.log(
            `DEBUG Journal transcript for ${conv.name} (${conv.id}): ` +
              `${messages.length} messages, ${textPartCount} text parts, ${transcript.length} chars`
          );
          journalText = await runJournal(conv.name, transcript);
          console.log(`DEBUG Journal entry for ${conv.name} (${conv.id}): ${journalText.length} chars`);
        } catch (error) {
          skippedIds.push(conv.id);
          await updateJobLog(jobId, { skippedConversationIds: skippedIds });
          console.error(
            'ERROR Failed to journal conversation ' + conv.id + ' for ' + conv.name + ': ' + error
          );
          continue;
        }
        await insertNextVersion(journalPath, journalText, collectedAt);
      }

      const current = await getCurrentVersion(journalPath);
      todaysJournals.push({
        conversationId: conv.id,
        userName: conv.name,
        content: current ? current.content : ''
      });
    }

    setTodaysJournals(todaysJournals);
    await updateJobLog(jobId, { lastCompletedPhase: '2-journal' });

    // -----------------------------------------------------------------------
    // Phase 3 -- Integrate (runs in full, fresh or resumed; only the empty-batch
    // short-circuit above skips it -- see spec notes)
    // -----------------------------------------------------------------------
    // The undelivered pending notes were already snapshotted right after Phase 1 (see above);
    // they ride along as extra evidence, so with zero conversations but a non-empty outbox the
    // run still consolidates them here instead of skipping.
    const integrateResult = await runIntegrate(executeIntegrateTool, undeliveredNotes);
    // Scratch conversation of the nightly agent; journal/review/compact calls use store:false instead.
    if (integrateResult.conversationId) {
      await deleteConversation(integrateResult.conversationId).catch(error =>
        console.warn(
          'WARN Failed to delete integrate conversation ' + integrateResult.conversationId + ': ' + error
        )
      );
    }
    const integrateTruncated = integrateResult.iterations >= config.nightly.maxIterations;
    if (integrateTruncated) {
      console.warn(
        'WARN Phase 3 integrate tool loop hit maxIterations (' +
          config.nightly.maxIterations +
          '); staged updates for this run may be incomplete'
      );
      // A truncated integrate may never have processed the pending-note evidence, so the notes
      // must survive for the next nightly run rather than be deleted unconsolidated.
      notesConsolidated = false;
    }
    const stagedUpdates: StagedUpdate[] = getStagedUpdates();
    await updateJobLog(jobId, { lastCompletedPhase: '3-integrate' });

    // -----------------------------------------------------------------------
    // Phase 4 -- Review + Archive
    // -----------------------------------------------------------------------
    const reviewResult = await runReviewPhase(stagedUpdates, todaysJournals, undeliveredNotes, collectedAt);
    const {
      filesUpdated: filesUpdatedFromReview,
      filesCreated: filesCreatedFromReview,
      anyReviewFailed
    } = reviewResult;
    notesConsolidated = notesConsolidated && reviewResult.notesConsolidated;

    await updateJobLog(jobId, {
      lastCompletedPhase: '4-archive',
      filesUpdated: filesUpdatedFromReview,
      filesCreated: filesCreatedFromReview
    });
    // Mood decay is deterministic code, not agent work: an existing mood fades exponentially
    // toward neutral with its own half-life every night, even when the agent staged no mood
    // update (no mood signal today). It runs BEFORE Phase 6 so the decayed version is synced to
    // the Mistral library in the SAME run, and Phase 7's compacted Profile of Yasmin reflects
    // the already-decayed state.
    await decayMoodFile(collectedAt).catch(error =>
      console.error('ERROR Failed to decay self-reflection/mood.md: ' + error)
    );

    // -----------------------------------------------------------------------
    // Phase 5 -- Dream (two-stage: dream generation + Yasmin's own reflection)
    // -----------------------------------------------------------------------
    const { dreamGenerated, anyDreamFailed } = await runDreamPhase(jobId, collectedAt);

    // -----------------------------------------------------------------------
    // Phase 6 -- Upload
    // -----------------------------------------------------------------------
    const uploadResult = await runUploadPhase();
    const { anyUploadFailed } = uploadResult;
    // Phase 8 outbox deletion failures also contribute to the final partial-status decision.
    let anyDeleteFailed = uploadResult.anyDeleteFailed;
    await updateJobLog(jobId, { lastCompletedPhase: '6-upload' });

    // -----------------------------------------------------------------------
    // Phase 7 -- Regenerate eager cache (always fully re-runs -- cheap, idempotent, purely local)
    // -----------------------------------------------------------------------
    // NOTE: this phase's upserts are NOT counted into the job log's filesUpdated/filesCreated --
    // it unconditionally rewrites every current file every night regardless of whether anything
    // actually changed, so it is not a meaningful "how much changed" signal (see Phase 4, which is).
    const anyEagerFailed = await runEagerPhase();
    await updateJobLog(jobId, { lastCompletedPhase: '7-eager' });
    // -----------------------------------------------------------------------
    // Phase 8 -- Pending-notes reset (outbox)
    // -----------------------------------------------------------------------
    // The outbox holds at most one day: once integrate + review/archive succeeded, every note
    // has served its purpose. Deliberately a plain DELETE (no TRUNCATE: DROP privileges /
    // implicit commit); a merely 'partial' run may still empty the outbox. Quiet-night
    // exception: the empty-batch skip above never reaches this phase, so delivered rows can
    // linger across consecutive quiet nights until the next non-empty run clears them.
    if (notesConsolidated && notesSnapshotMaxId > 0) {
      try {
        await clearIntradayNotes(notesSnapshotMaxId);
        console.log(
          'INFO Cleared the intraday_notes outbox (notes up to #' +
            notesSnapshotMaxId +
            ') after successful consolidation'
        );
      } catch (error) {
        console.error('ERROR Failed to clear the intraday_notes outbox: ' + error);
      }
    } else if (!notesConsolidated) {
      console.warn(
        'WARN Consolidation phases did not complete; keeping intraday_notes for the next nightly run'
      );
    } else {
      console.log('INFO intraday_notes outbox is empty; nothing to clear');
    }

    // -----------------------------------------------------------------------
    // Phase 9 -- Cleanup
    // -----------------------------------------------------------------------
    const idsToDelete = conversations.map(c => c.id).filter(id => !skippedIds.includes(id));
    for (const id of idsToDelete) {
      try {
        await deleteConversation(id);
      } catch (error) {
        console.error('ERROR Failed to delete conversation ' + id + ': ' + error);
        anyDeleteFailed = true;
      }
    }

    try {
      const prunedVersions = await pruneOldVersions(config.nightly.archiveKeepVersions, 2);
      console.log('INFO Pruned ' + prunedVersions + ' old memory_archive versions');
    } catch (error) {
      console.error('ERROR Failed to prune old memory_archive versions: ' + error);
    }

    try {
      const prunedLogs = await pruneOldJobLogs(90);
      console.log('INFO Pruned ' + prunedLogs + ' old nightly_job_log rows');
    } catch (error) {
      console.error('ERROR Failed to prune old nightly_job_log rows: ' + error);
    }

    const finalStatus: NightlyJobStatus =
      skippedIds.length === 0 &&
      !anyReviewFailed &&
      !anyDreamFailed &&
      !anyUploadFailed &&
      !anyDeleteFailed &&
      !anyEagerFailed &&
      !integrateTruncated
        ? 'completed'
        : 'partial';
    const conversationsProcessed = conversations.length;
    const filesUpdated = filesUpdatedFromReview;
    const filesCreated = filesCreatedFromReview;

    await updateJobLog(jobId, {
      status: finalStatus,
      completedAt: collectedAt,
      lastCompletedPhase: '9-cleanup',
      conversationsProcessed,
      filesUpdated,
      filesCreated
    });

    // Only a fully successful run advances the durable watermark, so a 'partial' run's failed pieces
    // get reprocessed by the next invocation. The watermark lives in its own non-pruned table rather
    // than the job log, which pruneOldJobLogs may delete from.
    if (finalStatus === 'completed') {
      await setWatermark(collectedAt);
    } else if (skippedIds.length > 0) {
      // Poison-pill valve: a conversation that fails journaling every night freezes the watermark
      // forever. When the stall exceeds the threshold (and only with journal data at stake --
      // other 'partial' causes are self-healing), advance to now - threshold, loudly (auditable).
      const stalledWatermark = await getWatermark();
      if (stalledWatermark && Date.now() - stalledWatermark.getTime() > config.nightly.watermarkStalenessMs) {
        const cutoff = new Date(Date.now() - config.nightly.watermarkStalenessMs);
        const abandoned = skippedIds.join(', ');
        console.error(
          'ERROR Watermark stalled since ' +
            stalledWatermark.toISOString() +
            ' (> ' +
            config.nightly.watermarkStalenessMs +
            'ms) with skipped conversations; advancing watermark to ' +
            cutoff.toISOString() +
            ' and abandoning conversation(s): ' +
            abandoned
        );
        try {
          await updateJobLog(jobId, {
            errorMessage: 'Watermark staleness threshold exceeded; abandoned conversation(s): ' + abandoned
          });
          await setWatermark(cutoff);
        } catch (advanceError) {
          console.error('ERROR Failed to advance stalled watermark: ' + advanceError);
        }
      }
    }

    return {
      jobId,
      status: finalStatus,
      conversationsProcessed,
      filesUpdated,
      filesCreated,
      dreamGenerated
    };
  } catch (error) {
    if (jobId !== undefined) {
      // Best-effort: if this write itself fails (e.g. DB outage), do not let that error replace the
      // real root cause being propagated below -- just log it and keep going.
      try {
        await updateJobLog(jobId, { status: 'failed', errorMessage: String(error), completedAt: true });
      } catch (logError) {
        console.error(
          'ERROR Failed to persist failed status to nightly_job_log for job ' + jobId + ': ' + logError
        );
      }
    }
    throw error;
  } finally {
    // Same reasoning: a failure here must not mask whatever error is already propagating out of the
    // try/catch above (JS finally-throw semantics would otherwise silently replace it).
    try {
      await releaseLock('nightly', owner);
    } catch (releaseError) {
      console.error('ERROR Failed to release the nightly processing lock: ' + releaseError);
    }
  }
}
