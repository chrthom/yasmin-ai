import { config } from '../config';
import { askAgent, runAgentToolLoop, ConversationMessage } from '../mistral/mistral_api';
import { isOverCap, truncateToCap } from './privacy';
import { loadTemplate, renderPrompt } from './prompts';
import { StagedUpdate, JournalEntry } from './tools';
import { IntradayNote } from '../database/models/intraday_notes.model';

// ---------------------------------------------------------------------------
// Shared transcript helpers
// ---------------------------------------------------------------------------

// Re-exported for callers that only need the message shape, without redefining it.
export type RawConversationMessage = ConversationMessage;

// Joins the text parts of a single message's content (string, or array of {type, text} parts) --
// mirrors the same content-shape assumptions as extractOutputText in mistral_api.ts.
export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: string; text?: string } => typeof part === 'object' && part !== null)
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text as string)
      .join(' ');
  }
  return '';
}

// The live agent seeds a fresh conversation (turn-limit reset or respawn) with a replayed summary and the
// last few messages of the previous one, wrapped in this block. It is context, not something the user said,
// and the previous conversation is journaled on its own -- so it must never reach the journal transcript.
const HANDOFF_BLOCK_RE = /<previous_conversation>[\s\S]*?<\/previous_conversation>\s*/g;

export function stripHandoffBlock(text: string): string {
  return text.replace(HANDOFF_BLOCK_RE, '').trim();
}

// Hard ceiling for the journal transcript. The live conversation can carry large internal tool results
// (e.g. a web_search read of a whole web page), which are low-information for memory yet, if allowed
// through, would balloon the journal prompt and can cause the journal agent to misbehave or emit nothing.
const TRANSCRIPT_MAX_CHARS = 20000;

// Internal plumbing isn't conversation content: tool calls, function calls/results (including giant
// web_search reads), system/service rows and errors should never reach the transcript that feeds memory.
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
 * Only real human<->assistant dialogue is kept, and the result is capped so a single oversized reply
 * can never blow up the downstream journal prompt.
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

  let transcript = lines.join('\n');
  if (transcript.length > TRANSCRIPT_MAX_CHARS) {
    transcript =
      transcript.slice(0, TRANSCRIPT_MAX_CHARS) +
      '\n…[transcript truncated by nightly harness; kept first ' +
      TRANSCRIPT_MAX_CHARS +
      ' chars]';
  }
  return transcript;
}

// ---------------------------------------------------------------------------
// Phase 2 -- Journal
// ---------------------------------------------------------------------------

/** Soft cap on journal length -- keeps the archive from bloating with runaway output, not a hard limit */
export const JOURNAL_SOFT_CAP_CHARS = 4000;

/**
 * Builds the Phase-2 prompt asking the nightly agent to journal a conversation with userName,
 * from the mistral_config/nightly/prompts/journal_prompt.txt template.
 */
export function journalPrompt(userName: string, transcript: string): string {
  return renderPrompt('journal_prompt.txt', { userName, transcript });
}

/**
 * Runs the Phase-2 journal call for one conversation, with one tighter retry and a truncation safety net
 */
export async function runJournal(userName: string, transcript: string): Promise<string> {
  let text = (
    await askAgent({
      agentId: config.mistral.nightlyAgentId,
      inputs: [{ role: 'user', content: journalPrompt(userName, transcript) }],
      store: false
    })
  ).outputText.trim();

  // An empty entry is ALWAYS abnormal -- the journal prompt tells the agent to write at least a
  // single short line ("If nothing meaningful happened ... write one short line") -- so an empty
  // reply means a failed/incomplete generation, not "nothing to say". Give it one clarifying retry;
  // if it stays empty, throw so the pipeline skips and reprocesses this conversation next night
  // instead of silently persisting an empty journal file that poisons the whole downstream run.
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
 * only mentioned as a parenthetical. Kept as one template so the voice rule is stated consistently.
 */
const SELF_PROFILE_VOICE_RULE = 'self_profile_voice_rule.txt';

/**
 * Builds the Phase-3 instruction that drives the tool-calling integrate loop, from the
 * mistral_config/nightly/prompts/integrate_prompt.txt template. Undelivered pending notes (the live
 * agent's cross-person outbox) are appended as extra evidence so a message that never reached its
 * recipient still survives in long-term memory.
 */
export function integratePrompt(undeliveredNotes: IntradayNote[] = []): string {
  const notesText = formatIntradayNotesText(undeliveredNotes);
  const undeliveredNotesBlock =
    notesText.length > 0 ? renderPrompt('integrate_notes_block.txt', { notesText }) : '';
  return renderPrompt('integrate_prompt.txt', {
    undeliveredNotes: undeliveredNotesBlock,
    selfProfileVoiceRule: loadTemplate(SELF_PROFILE_VOICE_RULE)
  });
}

/**
 * Runs the Phase-3 tool loop; the caller reads back what was staged via tools.ts's getStagedUpdates().
 * The conversation must stay stored (the loop continues it turn by turn), so the caller deletes the
 * returned conversationId once it is done.
 */
export async function runIntegrate(
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  undeliveredNotes: IntradayNote[] = []
): Promise<{ finalText: string; iterations: number; conversationId: string }> {
  const result = await runAgentToolLoop({
    agentId: config.mistral.nightlyAgentId,
    initialInputs: [{ role: 'user', content: integratePrompt(undeliveredNotes) }],
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
 * Formats today's journal entries into the shared evidence block used by the integrate, review and
 * revision prompts.
 */
function formatJournalsText(todaysJournals: JournalEntry[]): string {
  return todaysJournals
    .map(entry => '--- Journal entry for ' + entry.userName + ' ---\n' + entry.content)
    .join('\n\n');
}

/**
 * Builds the Phase-4 review prompt for a single staged update, given the evidence base. The attempt
 * number (0 for the initial review, 1+ for re-reviews after a revision) relaxes the grounding bar: the
 * first rejection is the only one that may cite weak grounding alone; later attempts must not keep a
 * proposal stuck on interpretive disagreement, because a revision cannot create evidence that the
 * journals never contained.
 */
export function reviewPrompt(
  update: StagedUpdate,
  currentContent: string | null,
  todaysJournals: JournalEntry[],
  attempt: number
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
  return renderPrompt('review_prompt.txt', {
    attemptSuffix:
      attempt > 0 ? ' (Review attempt ' + (attempt + 1) + ' -- an earlier version was rejected.)' : '',
    path: update.path,
    newFileSuffix: update.isNew ? ' (this is a brand-new file)' : '',
    newContent: update.content,
    currentContent: currentContent === null ? '(this is a brand-new file)' : currentContent,
    journalsText: journalsText.length > 0 ? journalsText : '(no journal entries today)',
    selfProfileVoiceRule: loadTemplate(SELF_PROFILE_VOICE_RULE),
    groundingRule
  });
}

/**
 * Runs the Phase-4 review call for one staged update; malformed verdicts are rejected as a safe default
 */
export async function runReview(
  update: StagedUpdate,
  currentContent: string | null,
  todaysJournals: JournalEntry[],
  attempt: number
): Promise<ReviewVerdict> {
  const result = await askAgent({
    agentId: config.mistral.nightlyAgentId,
    inputs: [{ role: 'user', content: reviewPrompt(update, currentContent, todaysJournals, attempt) }],
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
 * for a proposal the reviewer rejected, addressing every point of the reviewer's feedback
 */
export function revisePrompt(
  update: StagedUpdate,
  currentContent: string | null,
  rejectedContent: string,
  feedback: string,
  todaysJournals: JournalEntry[]
): string {
  const journalsText = formatJournalsText(todaysJournals);
  return renderPrompt('revise_prompt.txt', {
    path: update.path,
    currentContent: currentContent === null ? '(this is a brand-new file)' : currentContent,
    rejectedContent,
    feedback,
    journalsText: journalsText.length > 0 ? journalsText : '(no journal entries today)',
    selfProfileVoiceRule: loadTemplate(SELF_PROFILE_VOICE_RULE)
  });
}

/**
 * Builds the short follow-up prompt sent to an EXISTING revision conversation. The conversation already
 * holds the file context, the running proposal->feedback history, and the agent's own prior corrections,
 * so this turn points at the latest rejection -- keeping the whole history in scope for later revisions.
 * The day's journals are re-embedded here too (not just relied on from conversation memory), so every
 * revision re-grounds itself in the evidence even if later turns drift from the original seed.
 */
export function reviseFollowUpPrompt(
  update: StagedUpdate,
  rejectedContent: string,
  feedback: string,
  todaysJournals: JournalEntry[]
): string {
  const voiceRule =
    update.path === 'self-reflection/profile.md'
      ? '\nRemember: ' + loadTemplate(SELF_PROFILE_VOICE_RULE) + '\n'
      : '';
  const journalsText = formatJournalsText(todaysJournals);
  return renderPrompt('revise_follow_up_prompt.txt', {
    path: update.path,
    rejectedContent,
    feedback,
    journalsText: journalsText.length > 0 ? journalsText : '(no journal entries today)',
    voiceRule
  });
}

/**
 * Runs the Phase-4 revision for one staged update, returning the corrected full replacement content and
 * the conversation id so callers can keep revising within the SAME conversation (full proposal->feedback
 * history stays in scope). Pass the conversationId from a prior call to continue that conversation.
 */
export async function reviseProposal(
  update: StagedUpdate,
  currentContent: string | null,
  rejectedContent: string,
  feedback: string,
  todaysJournals: JournalEntry[],
  conversationId?: string
): Promise<{ content: string; conversationId: string }> {
  const inputs =
    conversationId === undefined
      ? [
          {
            role: 'user',
            content: revisePrompt(update, currentContent, rejectedContent, feedback, todaysJournals)
          }
        ]
      : [{ role: 'user', content: reviseFollowUpPrompt(update, rejectedContent, feedback, todaysJournals) }];

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

export type CompactKind = 'person' | 'yasmin' | 'family';

/**
 * Builds the Phase-6 compaction prompt for a given kind of long-term file
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
