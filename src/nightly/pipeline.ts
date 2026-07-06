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
async function computeSinceIso(): Promise<string> {
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
        stage_update(args['path'] as string, args['content'] as string, Boolean(args['isNew']))
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

    if (orphan) {
      jobId = orphan.id;
      resetNightlyToolsState();

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
      jobId = await createJobLog();
      resetNightlyToolsState();

      const sinceIso = await computeSinceIso();
      const allConversations = await listConversations(sinceIso);
      // Filter to the LIVE family chat agent's id -- NOT the nightly agent's id -- so the nightly
      // job's own scratch conversations (created below in phases 2-4) never get picked up as if
      // they were family conversations on a later run.
      const filtered = allConversations.filter(c => c.agentId === config.mistral.agentId);

      if (filtered.length === 0) {
        await updateJobLog(jobId, {
          status: 'completed',
          completedAt: true,
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
    await runIntegrate(executeIntegrateTool);
    const stagedUpdates: StagedUpdate[] = getStagedUpdates();
    await updateJobLog(jobId, { lastCompletedPhase: '3-integrate' });

    // -----------------------------------------------------------------------
    // Phase 4 -- Review + Archive
    // -----------------------------------------------------------------------
    let filesUpdatedFromReview = 0;
    let filesCreatedFromReview = 0;
    let anyRejected = false;

    for (const update of stagedUpdates) {
      const currentVersion = await getCurrentVersion(update.path);
      const currentContent = currentVersion ? currentVersion.content : null;

      const verdict = await runReview(update, currentContent, todaysJournals);

      if (verdict.approved) {
        const { created } = await insertNextVersion(update.path, update.content);
        if (created && update.isNew) {
          filesCreatedFromReview++;
        } else if (created && !update.isNew) {
          filesUpdatedFromReview++;
        }
      } else {
        console.warn('WARN Rejected staged update for ' + update.path + ': ' + verdict.reason);
        anyRejected = true;
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
    const unsynced = await listUnsynced();

    for (const row of unsynced) {
      try {
        const doc = await replaceDocument(row.filePath, row.content, row.mistralDocId ?? undefined);
        await markSynced(row.id, doc.id);
      } catch (error) {
        console.error('ERROR Failed to upload "' + row.filePath + '" to Mistral: ' + error);
        anyUploadFailed = true;
        continue;
      }
    }

    const currentVersionsForReconcile = await listCurrentVersions();
    const validPaths = new Set(currentVersionsForReconcile.map(v => v.filePath));
    const mistralDocs = await listDocuments();

    for (const doc of mistralDocs) {
      if (!validPaths.has(doc.path)) {
        try {
          await deleteDocument(doc.id);
        } catch (error) {
          console.error('ERROR Failed to delete orphaned Mistral document "' + doc.path + '": ' + error);
        }
      }
    }

    await updateJobLog(jobId, { lastCompletedPhase: '5-upload' });

    // -----------------------------------------------------------------------
    // Phase 6 -- Regenerate eager cache (always fully re-runs -- cheap, idempotent, purely local)
    // -----------------------------------------------------------------------
    let filesUpdatedFromEager = 0;
    let filesCreatedFromEager = 0;
    const allCurrentVersions = await listCurrentVersions();

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

      const stripped = stripSensitive(row.content);
      let compacted = await runCompact(kind, personName, stripped);
      if (isOverCap(compacted, config.nightly.eagerMaxChars)) {
        compacted = truncateToCap(compacted, config.nightly.eagerMaxChars);
      }

      const outcome = await upsertContextEntry(title, compacted);
      if (outcome === 'inserted') {
        filesCreatedFromEager++;
      } else {
        filesUpdatedFromEager++;
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
      skippedIds.length === 0 && !anyRejected && !anyUploadFailed ? 'completed' : 'partial';
    const conversationsProcessed = conversations.length;
    const filesUpdated = filesUpdatedFromReview + filesUpdatedFromEager;
    const filesCreated = filesCreatedFromReview + filesCreatedFromEager;

    await updateJobLog(jobId, {
      status: finalStatus,
      completedAt: true,
      lastCompletedPhase: '7-cleanup',
      conversationsProcessed,
      filesUpdated,
      filesCreated
    });

    return { jobId, status: finalStatus, conversationsProcessed, filesUpdated, filesCreated };
  } catch (error) {
    if (jobId !== undefined) {
      await updateJobLog(jobId, { status: 'failed', errorMessage: String(error), completedAt: true });
    }
    throw error;
  } finally {
    await releaseLock('nightly');
  }
}
