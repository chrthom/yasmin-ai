import { config } from '../config';
import { PREVIOUS_CONVERSATION_STRIP_RE } from '../protocol';
import { askAgent, runAgentToolLoop, ConversationMessage } from '../mistral/mistral_api';
import { extractContentText } from '../mistral/content';
import { isOverCap, truncateToCap } from './privacy';
import { loadTemplate, renderPrompt } from './prompts';
import { StagedUpdate, JournalEntry } from './tools';
import { IntradayNote } from '../database/models/intraday_notes.model';

export type { StagedUpdate };

// ---------------------------------------------------------------------------
// Shared transcript helpers
// ---------------------------------------------------------------------------

/** Re-exported for callers that only need the message shape, without redefining it. */
export type RawConversationMessage = ConversationMessage;

/**
 * Joins the text parts of a single message's content (string, or array of {type, text} parts).
 *
 * @param content The raw message content of unknown shape.
 * @returns The concatenated text parts, or an empty string for any other shape.
 */
export function extractMessageText(content: unknown): string {
  return extractContentText(content);
}

/**
 * Strips the `<previous_conversation>` block the live agent seeds a fresh conversation with
 * (turn-limit reset or respawn). It is context, not something the user said, and the previous
 * conversation is journaled on its own -- so it must never reach the journal transcript.
 *
 * @param text The raw stored user message text.
 * @returns The text with any handoff block removed.
 */
export function stripHandoffBlock(text: string): string {
  return text.replace(PREVIOUS_CONVERSATION_STRIP_RE, '').trim();
}

/**
 * Checks whether a message row is actual human<->assistant dialogue. Internal plumbing isn't
 * conversation content: tool calls, function calls/results (including giant web_search reads),
 * system/service rows and errors should never reach the transcript that feeds memory.
 *
 * @param message The raw message row.
 * @returns true when the row is dialogue and should be kept in a transcript.
 */
export function isDialogueMessage(message: ConversationMessage): boolean {
  const t = message.type.toLowerCase();
  return !(
    t.includes('tool') ||
    t.includes('function') ||
    t.includes('system') ||
    t.includes('service') ||
    t.includes('error')
  );
}

/**
 * Renders a conversation's messages into a plain "label: text" transcript, one line per message.
 * Only real human<->assistant dialogue is kept, and the result is capped so a single oversized
 * message (e.g. an oversized user paste) can never blow up the downstream journal prompt.
 *
 * @param messages The conversation's raw message history.
 * @returns The capped transcript, with the handoff block stripped from user messages.
 */
export function buildTranscript(messages: ConversationMessage[]): string {
  const lines: string[] = [];

  for (const message of messages) {
    if (!isDialogueMessage(message)) {
      continue;
    }
    const text = stripHandoffBlock(extractMessageText(message.content));
    if (text.length === 0) {
      continue;
    }
    const label = message.role || (message.type.includes('output') ? 'assistant' : 'user');
    lines.push(label + ': ' + text);
  }

  const transcriptMaxChars = config.nightly.transcriptMaxChars;
  let transcript = lines.join('\n');
  if (transcript.length > transcriptMaxChars) {
    transcript =
      transcript.slice(0, transcriptMaxChars) +
      '\n…[transcript truncated by nightly harness; kept first ' +
      transcriptMaxChars +
      ' chars]';
  }
  return transcript;
}

// ---------------------------------------------------------------------------
// Phase 2 -- Journal
// ---------------------------------------------------------------------------

/** Soft cap on journal length -- keeps the archive from bloating with runaway output, not a hard limit.
 * Named alias for config.nightly.journalSoftCapChars, kept as the domain term used by this module's
 * prompts and tests. */
export const JOURNAL_SOFT_CAP_CHARS: number = config.nightly.journalSoftCapChars;

/**
 * Builds the Phase-2 prompt asking the nightly agent to journal a conversation with userName,
 * from the mistral_config/nightly/prompts/journal_prompt.txt template.
 *
 * @param userName The conversation partner's name.
 * @param transcript The capped transcript to journal.
 * @returns The rendered prompt.
 */
export function journalPrompt(userName: string, transcript: string): string {
  return renderPrompt('journal_prompt.txt', { userName, transcript });
}

/**
 * Runs the Phase-2 journal call for one conversation, with one tighter retry and a truncation safety net
 *
 * @param userName The conversation partner's name.
 * @param transcript The capped transcript to journal.
 * @returns The journal entry text, within the soft cap.
 * @throws Error when the agent returns an empty entry on both attempts.
 */
export async function runJournal(userName: string, transcript: string): Promise<string> {
  let text = (
    await askAgent({
      agentId: config.mistral.nightlyAgentId,
      inputs: [{ role: 'user', content: journalPrompt(userName, transcript) }],
      store: false
    })
  ).outputText.trim();

  // An empty reply is always a failed generation, not "nothing to say": retry once, then throw so the
  // conversation is reprocessed next night instead of persisting an empty journal file.
  if (text.length === 0) {
    const retry = await askAgent({
      agentId: config.mistral.nightlyAgentId,
      inputs: [
        {
          role: 'user',
          content:
            journalPrompt(userName, transcript) +
            '\n\nYour previous answer was empty. Write the journal entry now.'
        }
      ],
      store: false
    });
    text = retry.outputText.trim();
    if (text.length === 0) {
      throw new Error('Journal agent returned an empty entry for ' + userName + ' on both attempts');
    }
  }

  if (!isOverCap(text, JOURNAL_SOFT_CAP_CHARS)) {
    return text;
  }

  const tighterPrompt =
    journalPrompt(userName, transcript) +
    '\n\nYour previous attempt was too long. Rewrite it in under ' +
    JOURNAL_SOFT_CAP_CHARS +
    ' characters, keeping only the most important points.';
  const second = await askAgent({
    agentId: config.mistral.nightlyAgentId,
    inputs: [{ role: 'user', content: tighterPrompt }],
    store: false
  });
  text = second.outputText.trim();

  if (isOverCap(text, JOURNAL_SOFT_CAP_CHARS)) {
    console.warn(
      'WARN Journal entry for ' +
        userName +
        ' still over the soft cap after retry; truncating deterministically'
    );
    text = truncateToCap(text, JOURNAL_SOFT_CAP_CHARS);
  }

  return text;
}

// ---------------------------------------------------------------------------
// Phase 3 -- Integrate
// ---------------------------------------------------------------------------

/**
 * The file-path grounding rule that integrate, review, and revision all share: Yasmin's own profile
 * must stay in first person, and it is easy for the nightly agent to slip into third person when it is
 * only mentioned as a parenthetical. Kept as one constant so the voice rule is stated consistently.
 */
const SELF_PROFILE_VOICE_RULE_TEMPLATE = 'self_profile_voice_rule.txt';

/**
 * The topics-layer rules that integrate and review share: cross-person themes live in topics/<topic>.md,
 * every topic file carries an Aliases line as a duplicate-matching anchor, and general/topic-index.md
 * is the mandatory registry a new topic must be written into.
 */
const TOPICS_RULE_TEMPLATE = 'topics_rule.txt';

/**
 * Formats a Date as YYYY-MM-DD in the configured memory timezone (MEMORY_TZ) -- the run date the
 * decay instruction tells the agent to judge file ages against.
 *
 * @param date The instant to format.
 * @returns The YYYY-MM-DD date string in MEMORY_TZ.
 */
export function formatRunDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.nightly.tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

/**
 * Builds the Phase-3 instruction that drives the tool-calling integrate loop. Undelivered
 * pending notes (the live agent's cross-person outbox) are appended as extra evidence so a
 * message that never reached its recipient still survives in long-term memory.
 *
 * @param runDate The run date the decay instruction judges file ages against.
 * @param undeliveredNotes Still-pending notes to append as extra evidence.
 * @returns The rendered Phase-3 instruction.
 */
export function integratePrompt(runDate: string, undeliveredNotes: IntradayNote[] = []): string {
  const notesText = formatIntradayNotesText(undeliveredNotes);
  const undeliveredNotesBlock =
    notesText.length > 0 ? renderPrompt('integrate_notes_block.txt', { notesText }) : '';
  return renderPrompt('integrate_prompt.txt', {
    runDate,
    undeliveredNotes: undeliveredNotesBlock,
    selfProfileVoiceRule: loadTemplate(SELF_PROFILE_VOICE_RULE_TEMPLATE),
    topicsRule: loadTemplate(TOPICS_RULE_TEMPLATE)
  });
}

/**
 * Runs the Phase-3 tool loop; the caller reads back what was staged via tools.ts's getStagedUpdates().
 * The conversation must stay stored (the loop continues it turn by turn), so the caller deletes the
 * returned conversationId once it is done.
 *
 * @param executeTool Dispatches one nightly-tool call by name.
 * @param undeliveredNotes Still-pending notes appended as extra evidence.
 * @returns The final agent text, the iterations run, and the scratch conversation id.
 */
export async function runIntegrate(
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  undeliveredNotes: IntradayNote[] = []
): Promise<{ finalText: string; iterations: number; conversationId: string }> {
  const result = await runAgentToolLoop({
    agentId: config.mistral.nightlyAgentId,
    initialInputs: [{ role: 'user', content: integratePrompt(formatRunDate(new Date()), undeliveredNotes) }],
    maxIterations: config.nightly.maxIterations,
    executeTool
  });

  return {
    finalText: result.finalText,
    iterations: result.iterations,
    conversationId: result.conversationId
  };
}

// ---------------------------------------------------------------------------
// Phase 4 -- Review
// ---------------------------------------------------------------------------

/** The reviewer's verdict on one staged update: approved, plus a reason either way. */
export interface ReviewVerdict {
  approved: boolean;
  reason: string;
}

const CODE_FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;

/** Strips a leading/trailing markdown code fence (```json ... ```), since models sometimes add one anyway */
function stripCodeFence(text: string): string {
  const match = CODE_FENCE_RE.exec(text.trim());
  return match ? match[1] : text.trim();
}

/** Formats the still-undelivered pending notes into the integrate evidence block */
function formatIntradayNotesText(notes: IntradayNote[]): string {
  return notes
    .map(
      note =>
        '--- Undelivered note #' +
        note.id +
        ' from ' +
        note.fromUsername +
        ' to ' +
        (note.toUsername ?? 'everyone') +
        ' ---\n' +
        note.content
    )
    .join('\n\n');
}

/**
 * Renders the still-undelivered pending notes into the evidence block shared by the review and
 * revision prompts (mirroring the integrate evidence block). Without it the reviewer's evidence
 * base is just the journals -- which on a quiet night (zero conversations) are empty -- so a
 * note-derived fact looks invented, gets rejected, and Phase 6.5 would still clear the outbox:
 * the note's content silently lost from long-term memory. Empty when there are no notes.
 */
function renderUndeliveredNotesBlock(undeliveredNotes: IntradayNote[]): string {
  const notesText = formatIntradayNotesText(undeliveredNotes);
  return notesText.length > 0 ? '\n\n' + renderPrompt('review_notes_block.txt', { notesText }) : '';
}

/**
 * Formats today's journal entries into the shared evidence block used by the integrate, review and
 * revision prompts.
 */
function formatJournalsText(todaysJournals: JournalEntry[]): string {
  return todaysJournals
    .map(entry => '--- Journal entry for ' + entry.userName + ' ---\n' + entry.content)
    .join('\n\n');
}

/** One archived topic file, as the duplicate-barrier evidence for reviewing topics/ proposals. */
export interface ExistingTopic {
  path: string;
  content: string;
}

/**
 * Per-topic excerpt cap for the duplicate barrier: the Aliases line plus the leading content is
 * plenty to judge semantic duplication; without a cap the review prompt grows unboundedly with
 * the number and size of topic files.
 */
const TOPIC_EXCERPT_MAX_CHARS = 600;

/**
 * Truncates a topic's content for the review prompt. The leading line (the Aliases line is the
 * duplicate-matching anchor) is always kept intact, even when it alone exceeds the cap; only the
 * remainder is truncated to the cap.
 *
 * @param content The topic file's full current content.
 * @returns The excerpt for the review prompt.
 */
function topicExcerpt(content: string): string {
  if (content.length <= TOPIC_EXCERPT_MAX_CHARS) {
    return content;
  }
  const aliased = content.replace(/\r/g, '');
  const firstLineBreak = aliased.indexOf('\n');
  if (firstLineBreak === -1) {
    return aliased + '\n...[truncated for review]';
  }
  const head = aliased.slice(0, firstLineBreak + 1);
  return (
    head +
    aliased.slice(head.length, head.length + TOPIC_EXCERPT_MAX_CHARS).trim() +
    '\n...[truncated for review]'
  );
}

/**
 * Builds the Phase-4 review prompt for a single staged update, given the evidence base. The attempt
 * number (0 for the initial review, 1+ for re-reviews after a revision) relaxes the grounding bar: the
 * first rejection is the only one that may cite weak grounding alone; later attempts must not keep a
 * proposal stuck on interpretive disagreement, because a revision cannot create evidence that the
 * journals never contained. The undelivered pending notes ride along as evidence too, so a fact the
 * integrate agent grounded in a note is not rejected as invented (see renderUndeliveredNotesBlock).
 *
 * @param update The staged update under review.
 * @param currentContent The file's current archived content, or null when new.
 * @param lastTouchedAt ISO timestamp of the current version's creation, or null when new.
 * @param todaysJournals The evidence base.
 * @param attempt 0 for the initial review, 1+ for re-reviews after a revision.
 * @param existingTopics Other archived topics, as the duplicate barrier for topics/ proposals.
 * @param undeliveredNotes Still-pending notes appended as extra evidence.
 * @returns The rendered review prompt.
 */
export function reviewPrompt(
  update: StagedUpdate,
  currentContent: string | null,
  lastTouchedAt: string | null,
  todaysJournals: JournalEntry[],
  attempt: number,
  existingTopics: ExistingTopic[] = [],
  undeliveredNotes: IntradayNote[] = []
): string {
  const journalsText = formatJournalsText(todaysJournals);
  const groundingRule =
    attempt === 0
      ? loadTemplate('review_grounding_first.txt')
      : renderPrompt('review_grounding_relaxed.txt', {
          synthesisKind:
            update.path === 'self-reflection/profile.md'
              ? 'personality traits, emotional patterns, and self-image derived from the interactions'
              : 'recurring-topic and character conclusions drawn from the interactions'
        });
  const existingTopicsBlock =
    update.path.toLowerCase().startsWith('topics/') && existingTopics.length > 0
      ? '\n\nExisting topics (EXCLUDING ' +
        update.path +
        '), each with its current content (long topics truncated):\n' +
        existingTopics
          .map(topic => '--- ' + topic.path + ' ---\n' + topicExcerpt(topic.content))
          .join('\n\n') +
        '\n\nTopic DUPLICATE rule, applied in EVERY attempt: if any existing topic above covers the same ' +
        'subject as the proposed topic -- by title, by its Aliases line, or by content -- the proposal is ' +
        'a DUPLICATE. Reject it with a reason that names the existing topic and proposes merging the ' +
        'new material into that existing topic file instead.\n'
      : '';
  return renderPrompt('review_prompt.txt', {
    attemptSuffix:
      attempt > 0 ? ' (Review attempt ' + (attempt + 1) + ' -- an earlier version was rejected.)' : '',
    path: update.path,
    newFileSuffix: update.isNew ? ' (this is a brand-new file)' : '',
    newContent: update.content,
    currentContent: currentContent === null ? '(this is a brand-new file)' : currentContent,
    journalsText: journalsText.length > 0 ? journalsText : '(no journal entries today)',
    undeliveredNotesBlock: renderUndeliveredNotesBlock(undeliveredNotes),
    existingTopicsBlock,
    selfProfileVoiceRule: loadTemplate(SELF_PROFILE_VOICE_RULE_TEMPLATE),
    groundingRule,
    runDate: formatRunDate(new Date()),
    lastTouched:
      lastTouchedAt === null
        ? 'never -- this would be its first version'
        : formatRunDate(new Date(lastTouchedAt))
  });
}

/**
 * Runs the Phase-4 review call for one staged update; malformed verdicts are rejected as a safe default
 *
 * @param update The staged update under review.
 * @param currentContent The file's current archived content, or null when new.
 * @param lastTouchedAt ISO timestamp of the current version's creation, or null when new.
 * @param todaysJournals The evidence base.
 * @param attempt 0 for the initial review, 1+ for re-reviews after a revision.
 * @param existingTopics Other archived topics, as the duplicate barrier for topics/ proposals.
 * @param undeliveredNotes Still-pending notes appended as extra evidence.
 * @returns The verdict; approved=false with a parse-failure reason when the reply is malformed.
 */
export async function runReview(
  update: StagedUpdate,
  currentContent: string | null,
  lastTouchedAt: string | null,
  todaysJournals: JournalEntry[],
  attempt: number,
  existingTopics: ExistingTopic[] = [],
  undeliveredNotes: IntradayNote[] = []
): Promise<ReviewVerdict> {
  const result = await askAgent({
    agentId: config.mistral.nightlyAgentId,
    inputs: [
      {
        role: 'user',
        content: reviewPrompt(
          update,
          currentContent,
          lastTouchedAt,
          todaysJournals,
          attempt,
          existingTopics,
          undeliveredNotes
        )
      }
    ],
    store: false
  });

  try {
    const parsed: unknown = JSON.parse(stripCodeFence(result.outputText));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { approved?: unknown }).approved === 'boolean'
    ) {
      const candidate = parsed as { approved: boolean; reason?: unknown };
      return {
        approved: candidate.approved,
        reason: typeof candidate.reason === 'string' ? candidate.reason : ''
      };
    }
    console.error('ERROR Malformed reviewer verdict for ' + update.path + ': ' + result.outputText);
  } catch (error) {
    console.error('ERROR Failed to parse reviewer verdict for ' + update.path + ': ' + error);
  }

  return { approved: false, reason: 'Could not parse reviewer verdict; rejecting as a safe default.' };
}

/**
 * Builds the Phase-4 revision prompt asking the nightly agent to produce a corrected FULL replacement
 * for a proposal the reviewer rejected, addressing every point of the reviewer's feedback. The
 * undelivered pending notes ride along as evidence so the correction can re-ground in them.
 *
 * @param update The staged update being revised.
 * @param currentContent The file's current archived content, or null when new.
 * @param rejectedContent The proposal version the reviewer rejected.
 * @param feedback The reviewer's rejection reason to address.
 * @param todaysJournals The evidence base.
 * @param undeliveredNotes Still-pending notes appended as extra evidence.
 * @returns The rendered revision prompt.
 */
export function revisePrompt(
  update: StagedUpdate,
  currentContent: string | null,
  rejectedContent: string,
  feedback: string,
  todaysJournals: JournalEntry[],
  undeliveredNotes: IntradayNote[] = []
): string {
  const journalsText = formatJournalsText(todaysJournals);
  return renderPrompt('revise_prompt.txt', {
    path: update.path,
    currentContent: currentContent === null ? '(this is a brand-new file)' : currentContent,
    rejectedContent,
    feedback,
    journalsText: journalsText.length > 0 ? journalsText : '(no journal entries today)',
    undeliveredNotesBlock: renderUndeliveredNotesBlock(undeliveredNotes),
    selfProfileVoiceRule: loadTemplate(SELF_PROFILE_VOICE_RULE_TEMPLATE)
  });
}

/**
 * Builds the follow-up prompt for a revision that continues an existing revision conversation:
 * the condensed variant without the full current content (already in the conversation history),
 * plus the voice rule for Yasmin's own profile.
 *
 * @param update The staged update being revised.
 * @param rejectedContent The proposal version the reviewer rejected.
 * @param feedback The reviewer's rejection reason to address.
 * @param todaysJournals The evidence base.
 * @returns The rendered follow-up prompt.
 */
export function reviseFollowUpPrompt(
  update: StagedUpdate,
  rejectedContent: string,
  feedback: string,
  todaysJournals: JournalEntry[],
  undeliveredNotes: IntradayNote[] = []
): string {
  const voiceRule =
    update.path === 'self-reflection/profile.md'
      ? '\nRemember: ' + loadTemplate(SELF_PROFILE_VOICE_RULE_TEMPLATE) + '\n'
      : '';
  const journalsText = formatJournalsText(todaysJournals);
  return renderPrompt('revise_follow_up_prompt.txt', {
    path: update.path,
    rejectedContent,
    feedback,
    journalsText: journalsText.length > 0 ? journalsText : '(no journal entries today)',
    undeliveredNotesBlock: renderUndeliveredNotesBlock(undeliveredNotes),
    voiceRule
  });
}

/**
 * Runs the Phase-4 revision for one staged update, returning the corrected full replacement content and
 * the conversation id so callers can keep revising within the SAME conversation (full proposal->feedback
 * history stays in scope). Pass the conversationId from a prior call to continue that conversation.
 * The undelivered pending notes ride along as evidence on every revision turn.
 *
 * @param update The staged update being revised.
 * @param currentContent The file's current archived content, or null when new.
 * @param rejectedContent The proposal version the reviewer rejected.
 * @param feedback The reviewer's rejection reason to address.
 * @param todaysJournals The evidence base.
 * @param conversationId A prior revision conversation to continue, when re-revising.
 * @param undeliveredNotes Still-pending notes appended as extra evidence.
 * @returns The corrected replacement content and the (possibly new) conversation id.
 */
export async function reviseProposal(
  update: StagedUpdate,
  currentContent: string | null,
  rejectedContent: string,
  feedback: string,
  todaysJournals: JournalEntry[],
  conversationId?: string,
  undeliveredNotes: IntradayNote[] = []
): Promise<{ content: string; conversationId: string }> {
  const inputs =
    conversationId === undefined
      ? [
          {
            role: 'user',
            content: revisePrompt(
              update,
              currentContent,
              rejectedContent,
              feedback,
              todaysJournals,
              undeliveredNotes
            )
          }
        ]
      : [
          {
            role: 'user',
            content: reviseFollowUpPrompt(update, rejectedContent, feedback, todaysJournals, undeliveredNotes)
          }
        ];

  const result = await askAgent({
    agentId: config.mistral.nightlyAgentId,
    conversationId,
    inputs
  });

  return {
    content: result.outputText.trim(),
    conversationId: result.conversationId || conversationId || ''
  };
}

// ---------------------------------------------------------------------------
// Phase 6 -- Compact
// ---------------------------------------------------------------------------

/** Which kind of long-term file a Phase-6 compaction prompt is built for. */
export type CompactKind = 'person' | 'yasmin' | 'family';

/**
 * Builds the Phase-6 compaction prompt for a given kind of long-term file
 *
 * @param kind Which kind of long-term file is being compacted.
 * @param personName The person's name, required for kind 'person' (undefined otherwise).
 * @param strippedContent The file's privacy-stripped current content.
 * @returns The rendered compaction prompt.
 */
export function compactPrompt(
  kind: CompactKind,
  personName: string | undefined,
  strippedContent: string
): string {
  const cap = String(config.nightly.eagerMaxChars);
  const headerName: Record<CompactKind, string> = {
    person: 'compact_person_prompt.txt',
    yasmin: 'compact_yasmin_prompt.txt',
    family: 'compact_family_prompt.txt'
  };
  const header = renderPrompt(headerName[kind], { cap, personName: personName ?? '' });
  return header + renderPrompt('compact_footer.txt', { content: strippedContent });
}

/**
 * Runs the Phase-6 compaction call for one long-term file, with one tighter retry and a truncation safety net
 *
 * @param kind Which kind of long-term file is being compacted.
 * @param personName The person's name, required for kind 'person' (undefined otherwise).
 * @param strippedContent The file's privacy-stripped current content.
 * @returns The compacted content, within the eager-cache cap.
 */
export async function runCompact(
  kind: CompactKind,
  personName: string | undefined,
  strippedContent: string
): Promise<string> {
  const cap = config.nightly.eagerMaxChars;

  const first = await askAgent({
    agentId: config.mistral.nightlyAgentId,
    inputs: [{ role: 'user', content: compactPrompt(kind, personName, strippedContent) }],
    store: false
  });
  let text = first.outputText.trim();
  if (!isOverCap(text, cap)) {
    return text;
  }

  const tighterPrompt =
    compactPrompt(kind, personName, strippedContent) +
    '\n\nYou are still over the ' +
    cap +
    ' character limit -- cut it down further, keep only what is essential.';
  const second = await askAgent({
    agentId: config.mistral.nightlyAgentId,
    inputs: [{ role: 'user', content: tighterPrompt }],
    store: false
  });
  text = second.outputText.trim();

  if (isOverCap(text, cap)) {
    console.warn(
      'WARN Compacted content for kind=' + kind + ' still over cap after retry; truncating deterministically'
    );
    text = truncateToCap(text, cap);
  }

  return text;
}
