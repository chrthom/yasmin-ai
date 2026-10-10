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
  clearPendingNotes,
  getPendingNotesMaxId,
  getUnconsolidatedNotes,
  PendingNote
} from '../database/models/pending_notes.model';
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
import { isOverCap, stripArchiveSection, stripSensitive, truncateToCap } from './privacy';
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
    let undeliveredNotes: PendingNote[] = [];
    // Watermark of the consolidation snapshot: phase 6.5 may only delete notes up to this id,
    // never a note the live agent staged after the snapshot while the review loop was running.
    // The watermark is MAX(id) over ALL notes (delivered ones included), not over the
    // undelivered subset: with only delivered notes the undelivered max would be 0 and the
    // bounded DELETE would remove nothing, so the outbox would never empty and grow unbounded.
    let notesSnapshotMaxId = 0;
    let notesConsolidated = true;
    try {
      notesSnapshotMaxId = await getPendingNotesMaxId();
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

    // The topics duplicate barrier: for a proposed topics/*.md file the reviewer must see every OTHER
    // topic (title, Aliases line, content) so it can reject a semantic duplicate before it ever
    // reaches the archive. Seeded from the archive and then EXTENDED as this run approves topic
    // files -- otherwise two new topics staged in one night would both pass the barrier.
    let topicsLoadFailed = false;
    let existingTopics: ExistingTopic[];
    try {
      const allCurrent = await listCurrentVersions();
      existingTopics = allCurrent
        .filter(row => row.filePath.toLowerCase().startsWith('topics/'))
        .map(row => ({ path: row.filePath, content: row.content }));
    } catch (error) {
      // The barrier set drives TWO safety mechanisms (duplicate detection and index validation).
      // On a load failure we must not silently degrade to an empty set: an approved index would
      // then have every topics/ line stripped, wiping the registry. Instead, skip BOTH mechanisms
      // for this run and mark it 'partial' so the next invocation retries with a working load.
      console.error(
        'ERROR Failed to load existing topics; skipping the topics duplicate barrier and index validation: ' +
          error
      );
      existingTopics = [];
      topicsLoadFailed = true;
      anyReviewFailed = true;
    }
    const archivedTopicPaths = new Set(existingTopics.map(topic => topic.path.toLowerCase()));
    // Topics skipped this run because the barrier load failed; collected across iterations so the
    // index (processed last) can drop their lines -- those files are known locally and were never
    // archived, so leaving their entries would create dangling registry references.
    const skippedTopicPaths = new Set<string>();

    // The topic index is reviewed LAST and validated against the topics that actually made it into
    // the archive: it references other files by path, so a rejected topics/*.md proposal must not
    // leave a dangling registry entry behind.
    const TOPIC_INDEX_PATH = 'general/topic-index.md';
    const orderedUpdates = [
      ...stagedUpdates.filter(update => update.path !== TOPIC_INDEX_PATH),
      ...stagedUpdates.filter(update => update.path === TOPIC_INDEX_PATH)
    ];

    for (const update of orderedUpdates) {
      try {
        const currentVersion = await getCurrentVersion(update.path);
        const currentContent = currentVersion ? currentVersion.content : null;
        const lastTouchedAt = currentVersion ? currentVersion.createdAt.toISOString() : null;

        let proposal = update.content;
        let verdict = await runReview(
          { path: update.path, content: proposal, isNew: update.isNew },
          currentContent,
          lastTouchedAt,
          todaysJournals,
          0,
          topicsLoadFailed ? [] : existingTopics.filter(topic => topic.path !== update.path)
        );

        // When the reviewer rejects a proposal, feed its feedback back to the agent so it can produce a
        // corrected full replacement, then re-review. This turns a persistent "rejected forever" case
        // into one that converges within a bounded number of revisions. All revisions for this file reuse
        // the SAME conversation (revisionConversationId), so the full proposal->feedback history stays in
        // the agent's context window instead of each call starting from scratch. The reviewer above stays
        // stateless (a fresh call every time) -- only the reviser accumulates state.
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
            topicsLoadFailed ? [] : existingTopics.filter(topic => topic.path !== update.path)
          );
          revisions++;
        }

        // The per-file revision conversation is nightly-agent scratch (filtered out of every future
        // collection, so it can never loop back in), but delete it now so we don't accumulate orphans.
        if (revisionConversationId) {
          await deleteConversation(revisionConversationId);
        }

        // Without barrier data this run cannot judge topic duplicates -- do not archive a possibly
        // duplicate topic on a broken load. The proposal is DROPPED: Phase 7 still deletes the
        // conversations and the next run rebuilds its journals only from ITS fresh conversations,
        // so nothing re-stages this material (same outcome as a rejected duplicate). The index, by
        // contrast, IS archived so the registry survives -- but with lines for this run's skipped
        // topics removed (see below), since those files are known locally and never got archived.
        const skipTopicArchive = topicsLoadFailed && update.path.toLowerCase().startsWith('topics/');
        if (skipTopicArchive) {
          skippedTopicPaths.add(update.path.toLowerCase());
          console.warn(
            'WARN Skipping archive of topic proposal ' +
              update.path +
              ' because the existing-topics load failed; it is DROPPED (not re-reviewed next run)'
          );
        }

        let contentToArchive = proposal;
        if (verdict.approved && update.path === TOPIC_INDEX_PATH) {
          // Registry validation: keep only the index lines whose topic file actually exists in the
          // archive (pre-existing or approved earlier in this same run), or -- on a broken topics
          // load, where the archive set is unknown -- at least drop the lines for topics THIS run
          // skipped. A rejected, never-staged, or skipped topic would otherwise leave a dangling
          // registry entry.
          const keptLines: string[] = [];
          const droppedLines: string[] = [];
          for (const line of proposal.split('\n')) {
            const match = /topics\/[a-z0-9-]+\.md/i.exec(line);
            if (match && skippedTopicPaths.has(match[0].toLowerCase())) {
              droppedLines.push(line);
              continue;
            }
            if (match && !topicsLoadFailed && !archivedTopicPaths.has(match[0].toLowerCase())) {
              droppedLines.push(line);
              continue;
            }
            keptLines.push(line);
          }
          if (droppedLines.length > 0) {
            console.warn(
              'WARN Dropping ' +
                droppedLines.length +
                ' topic-index line(s) whose topic file was not archived: ' +
                droppedLines.join(' | ')
            );
            contentToArchive = keptLines.join('\n');
          }
        }

        if (verdict.approved && !skipTopicArchive) {
          const { created } = await insertNextVersion(update.path, contentToArchive, collectedAt);
          // Classify create-vs-update from whether an archived version already existed, not from
          // the AI-supplied isNew flag, which is never cross-checked against real archive state.
          if (created && currentContent === null) {
            filesCreatedFromReview++;
          } else if (created) {
            filesUpdatedFromReview++;
          }
          // Extend the same-run duplicate barrier and the index-validation set with the newly
          // archived topic, so a second semantically-equal proposal staged this same night is
          // still caught by the reviewer, and the index can reference it.
          if (update.path.toLowerCase().startsWith('topics/')) {
            existingTopics.push({ path: update.path, content: contentToArchive });
            archivedTopicPaths.add(update.path.toLowerCase());
          }
        } else if (!verdict.approved) {
          // A reviewer rejection -- even after the revision cap -- is a normal, handled outcome: the
          // proposal is simply not written. It must not degrade a healthy run to 'partial' (which would
          // block the watermark and reprocess the same conversations forever). Log it so it stays
          // observable; the run still completes and advances the watermark.
          console.warn(
            'WARN Rejected staged update for ' + update.path + ' after enough revisions: ' + verdict.reason
          );
          // Rejected duplicates are DROPPED BY DESIGN: the reviewer is instructed to name the
          // existing topic to merge into, but this pipeline cannot rewrite that other file here
          // (reviseProposal only ever revises the same path). Because a rejection deliberately
          // does not degrade the run, the watermark still advances and the day's journal evidence
          // is NOT reprocessed -- so the proposal's material is gone from the topic layer and this
          // WARN is the only trace. It exists so the loss stays auditable and a human can merge
          // manually if the material mattered.
          if (!verdict.approved && update.path.toLowerCase().startsWith('topics/')) {
            console.warn(
              'WARN Topic proposal ' +
                update.path +
                ' was rejected (likely a duplicate) and is DROPPED BY DESIGN; its material is not merged automatically. ' +
                'Archived topics it may belong to: ' +
                (topicsLoadFailed ? '(unknown: topics load failed)' : [...archivedTopicPaths].join(', '))
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
    const currentByPath = new Map(currentVersionsForReconcile.map(v => [v.filePath, v]));

    // Group library docs by path so we can also catch same-path duplicates, which the sole
    // invalid-path orphan check below never sees: a failed replaceDocument delete (the delete
    // error is caught and logged, not rethrown) leaves a superseded copy of a still-valid path
    // behind, forever. For each duplicated path we keep only the doc the archive currently
    // references (its mistral_doc_id) and delete the rest.
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

      // Multiple copies of the same path. Keep the one the archive references; drop the rest.
      // If the archive has no reference here (mistral_doc_id null or no longer matching any
      // copy), we cannot tell which copy is live, so leave them all rather than guess.
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
        kind = 'person';
        personName = title.replace('Profile of ', '');
      }

      try {
        const stripped = stripArchiveSection(stripSensitive(row.content));
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
    // Phase 6.5 -- Pending-notes reset (outbox)
    // -----------------------------------------------------------------------
    // The outbox holds at most one day: after integrate (3) and review/archive (4) succeeded,
    // every note -- delivered or not -- has served its purpose (delivered notes live on in the
    // journals, undelivered ones were just consolidated as evidence). Deliberately a plain
    // DELETE, no TRUNCATE (DROP privileges / implicit commit). Only the failure of the
    // consolidation phases themselves keeps the notes for another day; a merely 'partial' run
    // (e.g. a failed upload) may still empty the outbox.
    if (notesConsolidated && notesSnapshotMaxId > 0) {
      try {
        await clearPendingNotes(notesSnapshotMaxId);
        console.log(
          'INFO Cleared the pending_notes outbox (notes up to #' +
            notesSnapshotMaxId +
            ') after successful consolidation'
        );
      } catch (error) {
        console.error('ERROR Failed to clear the pending_notes outbox: ' + error);
      }
    } else {
      console.warn(
        'WARN Consolidation phases did not complete; keeping pending_notes for the next nightly run'
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
      // forever (see above), so each run re-collects a growing batch while the blocked conversation
      // never clears. When the watermark has been stalled beyond the configured threshold -- and only
      // when journal data is actually at stake (skippedIds non-empty; other 'partial' causes like
      // upload/eager/delete failures are self-healing and re-picked-up independently of the
      // watermark) -- abandon the stalled window: advance the watermark to now - threshold, bounding
      // the data loss to the threshold window instead of blocking indefinitely. This is deliberately
      // loud (ERROR log + errorMessage on the job row) so the abandoned conversation ids stay
      // auditable, because their content is permanently lost to memory consolidation.
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
