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
import {
  buildTranscript,
  runCompact,
  runIntegrate,
  runJournal,
  runReview,
  reviseProposal,
  CompactKind,
  ExistingTopic
} from './reflection';
import { isOverCap, stripSensitive, truncateToCap } from './privacy';
import { pathToTitle } from './mapping';
import { personNameFromTitle, sanitizeForPath } from '../strings';
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
  /**
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
    // Phase 3 -- Integrate (always runs in full, fresh or resumed -- see spec notes)
    // -----------------------------------------------------------------------
    // Undelivered pending notes (the live agent's cross-person outbox) ride along as extra
    // evidence so a message that never reached its recipient still survives in long-term
    // memory. A failed read must not fail the run -- consolidation continues on journals alone.
    let undeliveredNotes: IntradayNote[] = [];
    // Watermark of the consolidation snapshot: phase 6.5 may only delete notes up to this id,
    // never one staged after the snapshot. MAX(id) covers ALL notes (delivered included) --
    // over only the undelivered subset the bounded DELETE would remove nothing.
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
      // The notes themselves were never consolidated here, so phase 6.5 must NOT delete them;
      // they stay in the outbox and are included again tomorrow.
      console.error('ERROR Failed to load undelivered pending notes; continuing without them: ' + error);
      notesConsolidated = false;
    }
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
    let filesUpdatedFromReview = 0;
    let filesCreatedFromReview = 0;
    let anyReviewFailed = false;

    // The topics duplicate barrier: for a proposed topics/*.md file the reviewer must see every
    // OTHER topic so it can reject a semantic duplicate before it reaches the archive. Seeded
    // from the archive and extended as this run approves topic files (same-night duplicates).
    let topicsLoadFailed = false;
    let existingTopics: ExistingTopic[];
    try {
      const allCurrent = await listCurrentVersions();
      existingTopics = allCurrent
        .filter(row => row.filePath.toLowerCase().startsWith('topics/'))
        .map(row => ({ path: row.filePath, content: row.content }));
    } catch (error) {
      // Without barrier data this run cannot judge topic duplicates: skip topics/ proposals
      // BEFORE reviewing (they are DROPPED -- nothing re-stages this material next run) and mark
      // the run 'partial', which keeps the watermark so the next invocation retries with a working load.
      console.error(
        'ERROR Failed to load existing topics; skipping topics/ proposals for this run: ' + error
      );
      existingTopics = [];
      topicsLoadFailed = true;
      anyReviewFailed = true;
    }

    // The topic index is reviewed LAST: it is advisory (only the agent reads it as a discovery
    // hint), so its lines are archived as staged without validation against the archive set. A
    // rare stale line after a rejected duplicate is cosmetic and fixed by the next run.
    const TOPIC_INDEX_PATH = 'general/topic-index.md';
    const orderedUpdates = [
      ...stagedUpdates.filter(update => update.path !== TOPIC_INDEX_PATH),
      ...stagedUpdates.filter(update => update.path === TOPIC_INDEX_PATH)
    ];

    for (const update of orderedUpdates) {
      try {
        // A failed barrier load leaves no basis for duplicate judgement: skip topics/ proposals
        // before spending review calls on them.
        if (topicsLoadFailed && update.path.toLowerCase().startsWith('topics/')) {
          console.warn(
            'WARN Skipping review of topic proposal ' +
              update.path +
              ' because the existing-topics load failed; it is DROPPED (not re-reviewed next run)'
          );
          continue;
        }
        const currentVersion = await getCurrentVersion(update.path);
        const currentContent = currentVersion ? currentVersion.content : null;
        const lastTouchedAt = currentVersion ? currentVersion.createdAt.toISOString() : null;

        let proposal = update.content;
        // The barrier for this file never changes across revisions (update.path is fixed), so
        // compute it once before the review/revision loop instead of on every attempt.
        const barrierForUpdate = topicsLoadFailed
          ? []
          : existingTopics.filter(topic => topic.path !== update.path);
        let verdict = await runReview(
          { path: update.path, content: proposal, isNew: update.isNew },
          currentContent,
          lastTouchedAt,
          todaysJournals,
          0,
          barrierForUpdate
        );

        // On rejection, feed the reviewer's feedback back to the agent for a corrected full
        // replacement, then re-review (bounded convergence). All revisions reuse the SAME
        // conversation so the proposal->feedback history stays in scope; the reviewer stays stateless.
        let revisions = 0;
        let revisionConversationId: string | undefined;
        while (!verdict.approved && revisions < config.nightly.maxRevisions) {
          const revised = await reviseProposal(
            update,
            currentContent,
            proposal,
            verdict.reason,
            todaysJournals,
            revisionConversationId
          );
          revisionConversationId = revised.conversationId || revisionConversationId;
          proposal = revised.content;
          verdict = await runReview(
            { path: update.path, content: proposal, isNew: update.isNew },
            currentContent,
            lastTouchedAt,
            todaysJournals,
            revisions + 1,
            barrierForUpdate
          );
          revisions++;
        }

        // The per-file revision conversation is nightly-agent scratch (filtered out of every future
        // collection, so it can never loop back in), but delete it now so we don't accumulate orphans.
        if (revisionConversationId) {
          await deleteConversation(revisionConversationId);
        }

        if (verdict.approved) {
          const { created } = await insertNextVersion(update.path, proposal, collectedAt);
          // Classify create-vs-update from whether an archived version already existed, not from
          // the AI-supplied isNew flag, which is never cross-checked against real archive state.
          if (created && currentContent === null) {
            filesCreatedFromReview++;
          } else if (created) {
            filesUpdatedFromReview++;
          }
          // Extend the same-run duplicate barrier with the newly archived topic, so a second
          // semantically-equal proposal staged this same night is still caught by the reviewer.
          if (update.path.toLowerCase().startsWith('topics/')) {
            existingTopics.push({ path: update.path, content: proposal });
          }
        } else {
          // A reviewer rejection is a normal, handled outcome: the proposal is simply not written
          // and the run must NOT degrade to 'partial' (which would block the watermark and
          // reprocess the same conversations forever). This WARN keeps it observable.
          console.warn(
            'WARN Rejected staged update for ' + update.path + ' after enough revisions: ' + verdict.reason
          );
          // Rejected topic duplicates are DROPPED BY DESIGN (reviseProposal only revises the
          // same path, so the material cannot be merged into the existing topic here): the
          // watermark still advances, so this WARN is the only auditable trace of the loss.
          if (update.path.toLowerCase().startsWith('topics/')) {
            console.warn(
              'WARN Topic proposal ' +
                update.path +
                ' was rejected (likely a duplicate) and is DROPPED BY DESIGN; its material is not merged automatically. ' +
                'Archived topics it may belong to: ' +
                (topicsLoadFailed
                  ? '(unknown: topics load failed)'
                  : existingTopics.map(topic => topic.path).join(', '))
            );
          }
        }
      } catch (error) {
        console.error('ERROR Failed to review/archive staged update for ' + update.path + ': ' + error);
        anyReviewFailed = true;
        notesConsolidated = false;
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
      // A transient read failure here would bubble to the outer catch and turn the whole run
      // into a non-resumable 'failed'. Demote it to a phase failure: skip the upload, mark
      // 'partial', and let the next invocation pick up the still-unsynced rows.
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
    const currentByPath = new Map(currentVersionsForReconcile.map(v => [v.filePath, v]));

    // Group library docs by path to also catch same-path duplicates (a failed replaceDocument
    // delete leaves a superseded copy of a still-valid path behind forever): for each duplicated
    // path keep only the doc the archive references (its mistral_doc_id) and delete the rest.
    const docsByPath = new Map<string, LibraryDocument[]>();
    for (const doc of mistralDocs) {
      const list = docsByPath.get(doc.path) ?? [];
      list.push(doc);
      docsByPath.set(doc.path, list);
    }

    for (const [path, docs] of docsByPath) {
      if (docs.length === 1) {
        // Single copy: fall through to the orphan check below.
        if (!currentByPath.has(path)) {
          try {
            await deleteDocument(docs[0].id);
          } catch (error) {
            console.error('ERROR Failed to delete orphaned Mistral document "' + path + '": ' + error);
            anyDeleteFailed = true;
          }
        }
        continue;
      }

      // Multiple copies of the same path: keep the one the archive references and drop the rest.
      // Without a matching reference we cannot tell which copy is live, so leave them all
      // rather than guess.
      const current = currentByPath.get(path);
      const keeper = current ? docs.find(d => d.id === current.mistralDocId) : undefined;
      if (!keeper) {
        console.warn(
          'WARN ' +
            path +
            ' has ' +
            docs.length +
            ' copies in the library but none matches the archived document id; leaving all copies'
        );
        continue;
      }
      for (const doc of docs) {
        if (doc.id === keeper.id) {
          continue;
        }
        try {
          await deleteDocument(doc.id);
        } catch (error) {
          console.error(
            'ERROR Failed to delete duplicate Mistral document "' + path + '" (' + doc.id + '): ' + error
          );
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
        const name = personNameFromTitle(title);
        if (name === null) {
          // Unreachable today -- people/ paths always map to "Profile of <name>" titles -- but
          // treat it like any other per-row failure rather than compacting against a wrong name.
          console.error('ERROR Phase 6 could not derive a person name from title "' + title + '"');
          anyEagerFailed = true;
          continue;
        }
        kind = 'person';
        personName = name;
      }

      try {
        const stripped = stripSensitive(row.content);
        let compacted = await runCompact(kind, personName, stripped);

        if (compacted.trim().length === 0) {
          // An empty source file simply has nothing to compact -- log and move on rather than
          // degrading a healthy run to 'partial'. A genuinely empty memory file is not a
          // failure.
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
    // Phase 6.5 -- Pending-notes reset (outbox)
    // -----------------------------------------------------------------------
    // The outbox holds at most one day: once integrate + review/archive succeeded, every note
    // has served its purpose. Deliberately a plain DELETE (no TRUNCATE: DROP privileges /
    // implicit commit); a merely 'partial' run may still empty the outbox.
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
    } else {
      console.warn(
        'WARN Consolidation phases did not complete; keeping intraday_notes for the next nightly run'
      );
    }

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
