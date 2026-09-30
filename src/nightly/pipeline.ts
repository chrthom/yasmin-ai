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
  listCurrentVersions,
  listUnsynced,
  markSynced,
  MemoryArchiveRow,
  pruneOldVersions
} from '../database/models/memory_archive.model';
import { upsertContextEntry } from '../database/models/context.model';
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
import { buildTranscript, runCompact, runIntegrate, runJournal, runReview, CompactKind } from './reflection';
import { isOverCap, stripSensitive, truncateToCap } from './privacy';
import { pathToTitle } from './mapping';
import {
  deleteConversation,
  deleteDocument,
  getConversationMessages,
  LibraryDocument,
  listConversations,
  listDocuments,
  replaceDocument
} from '../mistral/mistral_api';

/** Thrown when the nightly lock could not be acquired -- an expected outcome, not a failure to alert on */
export class LockHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockHeldError';
  }
}

export interface PipelineResult {
  jobId: number;
  status: NightlyJobStatus;
  conversationsProcessed: number;
  filesUpdated: number;
  filesCreated: number;
}

/** Lower-cases input and replaces every character that is not a-z, 0-9, or hyphen with a hyphen */
function sanitizeForPath(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * Computes the ISO watermark to pass to listConversations, falling back to 24h ago when the stored
 * watermark is missing or (guarding against corruption/clock skew) more than 1 hour in the future
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
    // whenever the whole job eventually finishes minutes later -- otherwise any conversation updated
    // in that gap is invisible to this run (already snapshotted) AND permanently invisible to every
    // future run (its updated_at will never again clear a later watermark). See computeSinceIso/
    // getWatermark for the read side of this contract.
    let collectedAt: Date;

    // Only treat the orphan as a genuine resume if Phase 1 had already durably recorded its
    // conversation batch (processedConversationIds is non-empty). If the process crashed between
    // createJobLog() and that write, there is nothing safe to resume -- fall through to the same
    // fresh-collection path as a brand-new job (still reusing the orphan's row/id, so we don't leave
    // it dangling), rather than silently treating an empty id list as "nothing to process".
    if (orphan && orphan.processedConversationIds.length > 0) {
      jobId = orphan.id;
      resetNightlyToolsState();
      // The resumed batch is a fixed replay of the original run's conversations, so the watermark we
      // persist on completion must reflect when that original batch was snapshotted -- NOT "now". We
      // don't persist the exact collection instant, so startedAt is the closest available proxy (the
      // gap is seconds). Writing a watermark of "now" here would drop any conversation that changed
      // between the original snapshot and this resume.
      collectedAt = orphan.startedAt;

      // Recover usernames for the reused id list by re-listing with the same watermark-derived
      // sinceIso and filtering down to just the ids we already know about -- the id list itself is
      // NOT re-derived from this call, it comes straight from the orphaned row for byte-identical
      // reprocessing of the same batch.
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

      if (filtered.length === 0) {
        await updateJobLog(jobId, {
          status: 'completed',
          completedAt: collectedAt,
          lastCompletedPhase: '1-collect',
          conversationsProcessed: 0
        });
        return { jobId, status: 'completed', conversationsProcessed: 0, filesUpdated: 0, filesCreated: 0 };
      }

      await updateJobLog(jobId, {
        processedConversationIds: filtered.map(c => c.id),
        lastCompletedPhase: '1-collect'
      });

      conversations = filtered.map(c => ({ id: c.id, name: c.name || c.id }));
    }

    // KNOWN GAP: the nightly agent's own scratch conversations (journal/integrate/review calls
    // below) are not currently cleaned up -- each is a short-lived one-shot or short tool-loop
    // conversation; revisit if Mistral conversation volume becomes a concern.

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
          journalText = await runJournal(conv.name, transcript);
        } catch (error) {
          skippedIds.push(conv.id);
          await updateJobLog(jobId, { skippedConversationIds: skippedIds });
          console.error(
            'ERROR Failed to journal conversation ' + conv.id + ' for ' + conv.name + ': ' + error
          );
          continue;
        }
        await insertNextVersion(journalPath, journalText);
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
    // Phase 3 -- Integrate (always runs in full, fresh or resumed -- see spec notes)
    // -----------------------------------------------------------------------
    const integrateResult = await runIntegrate(executeIntegrateTool);
    const integrateTruncated = integrateResult.iterations >= config.nightly.maxIterations;
    if (integrateTruncated) {
      console.warn(
        'WARN Phase 3 integrate tool loop hit maxIterations (' +
          config.nightly.maxIterations +
          '); staged updates for this run may be incomplete'
      );
    }
    const stagedUpdates: StagedUpdate[] = getStagedUpdates();
    await updateJobLog(jobId, { lastCompletedPhase: '3-integrate' });

    // -----------------------------------------------------------------------
    // Phase 4 -- Review + Archive
    // -----------------------------------------------------------------------
    let filesUpdatedFromReview = 0;
    let filesCreatedFromReview = 0;
    let anyRejected = false;
    let anyReviewFailed = false;

    for (const update of stagedUpdates) {
      try {
        const currentVersion = await getCurrentVersion(update.path);
        const currentContent = currentVersion ? currentVersion.content : null;

        const verdict = await runReview(update, currentContent, todaysJournals);

        if (verdict.approved) {
          const { created } = await insertNextVersion(update.path, update.content);
          // Classify create-vs-update from whether an archived version already existed, not from
          // the AI-supplied isNew flag, which is never cross-checked against real archive state.
          if (created && currentContent === null) {
            filesCreatedFromReview++;
          } else if (created) {
            filesUpdatedFromReview++;
          }
        } else {
          console.warn('WARN Rejected staged update for ' + update.path + ': ' + verdict.reason);
          anyRejected = true;
        }
      } catch (error) {
        console.error('ERROR Failed to review/archive staged update for ' + update.path + ': ' + error);
        anyReviewFailed = true;
      }
    }

    await updateJobLog(jobId, {
      lastCompletedPhase: '4-archive',
      filesUpdated: filesUpdatedFromReview,
      filesCreated: filesCreatedFromReview
    });

    // -----------------------------------------------------------------------
    // Phase 5 -- Upload
    // -----------------------------------------------------------------------
    let anyUploadFailed = false;
    let anyDeleteFailed = false;
    let unsynced: MemoryArchiveRow[];
    try {
      unsynced = await listUnsynced();
    } catch (error) {
      // An unguarded transient read failure here would bubble to the outer catch and turn the whole
      // run into a non-resumable 'failed'. Demote it to a phase failure instead: skip the upload, mark
      // the run 'partial', and let the next invocation pick up the still-unsynced rows.
      console.error('ERROR Phase 5 failed to list unsynced rows; skipping upload: ' + error);
      anyUploadFailed = true;
      unsynced = [];
    }

    for (const row of unsynced) {
      try {
        // Sensitive passages never leave local storage: memory_archive keeps the full content for
        // versioning/audit, but only the stripped copy is ever uploaded to the third-party Mistral
        // library, which backs RAG retrieval for the live chat agent.
        const uploadContent = stripSensitive(row.content);
        // An empty memory file carries no information and Mistral rejects empty document uploads
        // (HTTP 400) -- skip it rather than degrading the run to 'partial' on a file with nothing to say.
        if (uploadContent.trim().length === 0) {
          console.log('INFO Skipping upload of empty file "' + row.filePath + '"');
          continue;
        }
        const doc = await replaceDocument(row.filePath, uploadContent, row.mistralDocId ?? undefined);
        await markSynced(row.id, doc.id);
      } catch (error) {
        console.error('ERROR Failed to upload "' + row.filePath + '" to Mistral: ' + error);
        anyUploadFailed = true;
        continue;
      }
    }

    let currentVersionsForReconcile: MemoryArchiveRow[] = [];
    let mistralDocs: LibraryDocument[] = [];
    try {
      currentVersionsForReconcile = await listCurrentVersions();
      mistralDocs = await listDocuments();
    } catch (error) {
      // Same resumability rationale: without the orphan-cleanup inputs we cannot safely tell which
      // library docs are orphans, so skip the deletions, mark 'partial', and retry next run.
      console.error(
        'ERROR Phase 5 failed to reconcile Mistral library documents; skipping orphan cleanup: ' + error
      );
      anyDeleteFailed = true;
    }
    const validPaths = new Set(currentVersionsForReconcile.map(v => v.filePath));

    for (const doc of mistralDocs) {
      if (!validPaths.has(doc.path)) {
        try {
          await deleteDocument(doc.id);
        } catch (error) {
          console.error('ERROR Failed to delete orphaned Mistral document "' + doc.path + '": ' + error);
          anyDeleteFailed = true;
        }
      }
    }

    await updateJobLog(jobId, { lastCompletedPhase: '5-upload' });

    // -----------------------------------------------------------------------
    // Phase 6 -- Regenerate eager cache (always fully re-runs -- cheap, idempotent, purely local)
    // -----------------------------------------------------------------------
    // NOTE: this phase's upserts are NOT counted into the job log's filesUpdated/filesCreated --
    // it unconditionally rewrites every current file every night regardless of whether anything
    // actually changed, so it is not a meaningful "how much changed" signal (see Phase 4, which is).
    let anyEagerFailed = false;
    let allCurrentVersions: MemoryArchiveRow[];
    try {
      allCurrentVersions = await listCurrentVersions();
    } catch (error) {
      // Same resumability rationale as Phase 5: leave the eager cache untouched this run and mark
      // 'partial' so phase 6 re-runs next invocation.
      console.error(
        'ERROR Phase 6 failed to load current versions; leaving the eager cache untouched: ' + error
      );
      anyEagerFailed = true;
      allCurrentVersions = [];
    }

    for (const row of allCurrentVersions) {
      const title = pathToTitle(row.filePath);
      if (title === null) {
        continue;
      }

      let kind: CompactKind;
      let personName: string | undefined;

      if (row.filePath === 'self-reflection/profile.md') {
        kind = 'yasmin';
      } else if (row.filePath === 'general/family.md') {
        kind = 'family';
      } else {
        kind = 'person';
        personName = title.replace('Profile of ', '');
      }

      try {
        const stripped = stripSensitive(row.content);
        let compacted = await runCompact(kind, personName, stripped);

        if (compacted.trim().length === 0) {
          // An empty source file (e.g. an empty family file) simply has nothing to compact -- log it
          // and move on rather than degrading a healthy run to 'partial'. A genuinely empty memory
          // file is not an eager-cache failure.
          console.log(
            'INFO Phase 6 compaction produced empty output for "' +
              row.filePath +
              '"; skipping eager-cache update (no content)'
          );
          continue;
        }

        if (isOverCap(compacted, config.nightly.eagerMaxChars)) {
          compacted = truncateToCap(compacted, config.nightly.eagerMaxChars);
        }

        await upsertContextEntry(title, compacted);
      } catch (error) {
        console.error('ERROR Failed to regenerate eager cache entry for "' + row.filePath + '": ' + error);
        anyEagerFailed = true;
      }
    }

    await updateJobLog(jobId, { lastCompletedPhase: '6-eager' });

    // -----------------------------------------------------------------------
    // Phase 7 -- Cleanup
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
      !anyRejected &&
      !anyReviewFailed &&
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
      lastCompletedPhase: '7-cleanup',
      conversationsProcessed,
      filesUpdated,
      filesCreated
    });

    // Only a fully successful run advances the durable watermark, so a 'partial' run's failed pieces
    // get reprocessed by the next invocation. The watermark lives in its own non-pruned table rather
    // than the job log, which pruneOldJobLogs may delete from.
    if (finalStatus === 'completed') {
      await setWatermark(collectedAt);
    }

    return { jobId, status: finalStatus, conversationsProcessed, filesUpdated, filesCreated };
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
