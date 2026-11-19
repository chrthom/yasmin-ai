import { config } from '../config';
import { IntradayNote } from '../database/models/intraday_notes.model';
import {
  getCurrentVersion,
  insertNextVersion,
  listCurrentVersions
} from '../database/models/memory_archive.model';
import { deleteConversation } from '../mistral/mistral_api';
import { MOOD_FILE_PATH, stampMoodUpdatedAt } from './mood';
import { ExistingTopic, reviseProposal, runReview } from './reflection';
import { JournalEntry, StagedUpdate } from './tools';

/** Review and archive results, including whether a per-file failure puts note consolidation at risk. */
export interface ReviewPhaseResult {
  filesUpdated: number;
  filesCreated: number;
  anyReviewFailed: boolean;
  notesConsolidated: boolean;
}

/**
 * Reviews and archives staged updates in order, maintaining the same-night topic duplicate barrier.
 * On quiet nights journals may be empty: notes accompany review and revision so note-derived facts
 * are not rejected as invented before Phase 8 clears the outbox. Per-file errors prevent clearing.
 *
 * @param stagedUpdates - Proposed file contents; the advisory topic index is reviewed last.
 * @param todaysJournals - Journal evidence for review and revision.
 * @param undeliveredNotes - Bounded outbox snapshot supplying evidence absent from journals.
 * @param collectedAt - Archive timestamp, also overriding agent-supplied mood timestamps.
 * @returns Counts of newly archived existing/new files (not inferred from isNew), a failure flag
 * driving partial status, and the note-clear guard. Handled rejections leave that guard true;
 * topic-barrier load failures currently do too (known data-loss edge tracked in issue #146).
 */
export async function runReviewPhase(
  stagedUpdates: StagedUpdate[],
  todaysJournals: JournalEntry[],
  undeliveredNotes: IntradayNote[],
  collectedAt: Date
): Promise<ReviewPhaseResult> {
  let filesUpdated = 0;
  let filesCreated = 0;
  let anyReviewFailed = false;
  let notesConsolidated = true;

  // Seed the duplicate barrier from the archive and extend it with approved same-night topics.
  let topicsLoadFailed = false;
  let existingTopics: ExistingTopic[];
  try {
    const allCurrent = await listCurrentVersions();
    existingTopics = allCurrent
      .filter(row => row.filePath.toLowerCase().startsWith('topics/'))
      .map(row => ({ path: row.filePath, content: row.content }));
  } catch (error) {
    // Without barrier data, drop topic proposals and mark the run partial. Existing behavior leaves
    // notesConsolidated true, so Phase 8 may lose note-derived topic facts; follow-up: issue #146.
    console.error('ERROR Failed to load existing topics; skipping topics/ proposals for this run: ' + error);
    existingTopics = [];
    topicsLoadFailed = true;
    anyReviewFailed = true;
  }

  // The advisory topic index is reviewed last, without validating its lines against the archive.
  const TOPIC_INDEX_PATH = 'general/topic-index.md';
  const orderedUpdates = [
    ...stagedUpdates.filter(update => update.path !== TOPIC_INDEX_PATH),
    ...stagedUpdates.filter(update => update.path === TOPIC_INDEX_PATH)
  ];

  for (const update of orderedUpdates) {
    try {
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
      const barrierForUpdate = topicsLoadFailed
        ? []
        : existingTopics.filter(topic => topic.path !== update.path);
      let verdict = await runReview(
        { path: update.path, content: proposal, isNew: update.isNew },
        currentContent,
        lastTouchedAt,
        todaysJournals,
        0,
        barrierForUpdate,
        undeliveredNotes
      );

      // Revisions share one scratch conversation; the reviewer remains stateless.
      let revisions = 0;
      let revisionConversationId: string | undefined;
      while (!verdict.approved && revisions < config.nightly.maxRevisions) {
        const revised = await reviseProposal(
          update,
          currentContent,
          proposal,
          verdict.reason,
          todaysJournals,
          revisionConversationId,
          undeliveredNotes
        );
        revisionConversationId = revised.conversationId || revisionConversationId;
        proposal = revised.content;
        verdict = await runReview(
          { path: update.path, content: proposal, isNew: update.isNew },
          currentContent,
          lastTouchedAt,
          todaysJournals,
          revisions + 1,
          barrierForUpdate,
          undeliveredNotes
        );
        revisions++;
      }

      if (revisionConversationId) {
        await deleteConversation(revisionConversationId);
      }

      let contentToArchive = proposal;
      if (verdict.approved && update.path === MOOD_FILE_PATH) {
        // The archive time overrides the agent-supplied mood timestamp.
        contentToArchive = stampMoodUpdatedAt(contentToArchive, collectedAt);
      }
      if (verdict.approved) {
        const { created } = await insertNextVersion(update.path, contentToArchive, collectedAt);
        // Classify from archive state, not the AI-supplied isNew flag.
        if (created && currentContent === null) {
          filesCreated++;
        } else if (created) {
          filesUpdated++;
        }
        if (update.path.toLowerCase().startsWith('topics/')) {
          existingTopics.push({ path: update.path, content: proposal });
        }
      } else {
        // A rejection is handled, not a partial run, even when topic material is dropped.
        console.warn(
          'WARN Rejected staged update for ' + update.path + ' after enough revisions: ' + verdict.reason
        );
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

  return { filesUpdated, filesCreated, anyReviewFailed, notesConsolidated };
}
