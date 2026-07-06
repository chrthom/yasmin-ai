import { config } from '../config';
import { askAgent, runAgentToolLoop, ConversationMessage } from '../mistral/mistral_api';
import { isOverCap, truncateToCap } from './privacy';
import { StagedUpdate, JournalEntry } from './tools';

// ---------------------------------------------------------------------------
// Shared transcript helpers
// ---------------------------------------------------------------------------

// Re-exported for callers that only need the message shape, without redefining it.
export type RawConversationMessage = ConversationMessage;

// Joins the text parts of a single message's content (string, or array of {type, text} parts) --
// mirrors the same content-shape assumptions as extractOutputText in mistral_api.ts.
function extractMessageText(content: unknown): string {
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

/**
 * Renders a conversation's messages into a plain "label: text" transcript, one line per message
 */
export function buildTranscript(messages: ConversationMessage[]): string {
  const lines: string[] = [];

  for (const message of messages) {
    const label = message.role || (message.type.includes('output') ? 'assistant' : 'user');
    const text = extractMessageText(message.content);
    if (text.length === 0) {
      continue;
    }
    lines.push(label + ': ' + text);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Phase 2 -- Journal
// ---------------------------------------------------------------------------

/** Soft cap on journal length -- keeps the archive from bloating with runaway output, not a hard limit */
export const JOURNAL_SOFT_CAP_CHARS = 4000;

/**
 * Builds the Phase-2 prompt asking the nightly agent to journal a conversation with userName
 */
export function journalPrompt(userName: string, transcript: string): string {
  return (
    "Write a journal entry summarizing today's conversation with " +
    userName +
    '.\n\n' +
    'Write in plain prose, third person, with no title, no metadata, and no markdown headings -- just the ' +
    'journal content itself.\n' +
    'Focus on meaningful interactions, emotional exchanges, milestones, shared experiences, inside jokes, ' +
    'and any facts or commitments that should be remembered.\n' +
    'If nothing meaningful happened in this conversation, write one short line saying so instead of padding ' +
    'the entry with filler.\n\n' +
    'Transcript of the conversation with ' +
    userName +
    ':\n' +
    transcript
  );
}

/**
 * Runs the Phase-2 journal call for one conversation, with one tighter retry and a truncation safety net
 */
export async function runJournal(userName: string, transcript: string): Promise<string> {
  const first = await askAgent({
    agentId: config.mistral.nightlyAgentId,
    inputs: [{ role: 'user', content: journalPrompt(userName, transcript) }]
  });
  let text = first.outputText.trim();
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
    inputs: [{ role: 'user', content: tighterPrompt }]
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
 * Builds the Phase-3 instruction that drives the tool-calling integrate loop
 */
export function integratePrompt(): string {
  return (
    "You are consolidating today's long-term memory for a family assistant.\n\n" +
    'First, call list_long_term_files and read_todays_journals to see what long-term files already exist ' +
    'and what happened today.\n\n' +
    'For every long-term file that needs a new fact, an updated Recent Happenings or Open Topics section, ' +
    'or a brand-new person profile: if the file already exists, call get_long_term_file first to read its ' +
    'current content, then call stage_update with the COMPLETE new content for that path -- a full ' +
    'replacement, never a diff or a patch. Only stage files that genuinely need a change; leave files that ' +
    'are already accurate untouched.\n\n' +
    "Remember the file path conventions: people/<name>.md for a person's profile, " +
    "self-reflection/profile.md for Yasmin's own self-profile (first person), and general/family.md for " +
    'family-wide notes. Person profiles use the 5-section template (Core Facts, Current Attitude, Recent ' +
    "Happenings, Open Topics, Yasmin's Intentions), and any passage the concerned person would not want " +
    'casually surfaced to other family members should be wrapped in [PRIVACY:SENSITIVE] / ' +
    '[/PRIVACY:SENSITIVE] markers, each on its own line.\n\n' +
    'Once you have staged everything needed, reply with a short plain-text summary of what you staged and ' +
    'make no further tool calls.'
  );
}

/**
 * Runs the Phase-3 tool loop; the caller reads back what was staged via tools.ts's getStagedUpdates()
 */
export async function runIntegrate(
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>
): Promise<{ finalText: string; iterations: number }> {
  const result = await runAgentToolLoop({
    agentId: config.mistral.nightlyAgentId,
    initialInputs: [{ role: 'user', content: integratePrompt() }],
    maxIterations: config.nightly.maxIterations,
    executeTool
  });

  return { finalText: result.finalText, iterations: result.iterations };
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

/**
 * Builds the Phase-4 review prompt for a single staged update, given the evidence base
 */
export function reviewPrompt(
  update: StagedUpdate,
  currentContent: string | null,
  todaysJournals: JournalEntry[]
): string {
  const journalsText = todaysJournals
    .map(entry => '--- Journal entry for ' + entry.userName + ' ---\n' + entry.content)
    .join('\n\n');

  return (
    'You are reviewing a proposed long-term memory file update before it is committed.\n\n' +
    'Proposed new content for ' +
    update.path +
    (update.isNew ? ' (this is a brand-new file)' : '') +
    ':\n' +
    update.content +
    '\n\nCurrent content of ' +
    update.path +
    ':\n' +
    (currentContent === null ? '(this is a brand-new file)' : currentContent) +
    "\n\nToday's journal entries, the evidence base for this update:\n" +
    (journalsText.length > 0 ? journalsText : '(no journal entries today)') +
    '\n\nJudge whether the proposed content is well-grounded in the evidence above (not hallucinated), ' +
    'reasonable, and does not destructively discard information that should have been kept.\n\n' +
    'Reply with STRICTLY a single JSON object of this exact shape and nothing else -- no markdown code ' +
    'fence, no extra prose:\n' +
    '{"approved": boolean, "reason": string}'
  );
}

/**
 * Runs the Phase-4 review call for one staged update; malformed verdicts are rejected as a safe default
 */
export async function runReview(
  update: StagedUpdate,
  currentContent: string | null,
  todaysJournals: JournalEntry[]
): Promise<ReviewVerdict> {
  const result = await askAgent({
    agentId: config.mistral.nightlyAgentId,
    inputs: [{ role: 'user', content: reviewPrompt(update, currentContent, todaysJournals) }]
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
  const cap = config.nightly.eagerMaxChars;
  const footer =
    '\n\nReply with ONLY the compacted content -- no preamble, no explanation of what you did.\n\n' +
    'Content to compact:\n' +
    strippedContent;

  if (kind === 'person') {
    return (
      'Compact the following content about ' +
      personName +
      ' into EXACTLY this markdown template, in this exact order:\n\n' +
      "## Core Facts\n## Current Attitude\n## Recent Happenings\n## Open Topics\n## Yasmin's Intentions\n\n" +
      'Write about ' +
      personName +
      ' in third person. Preserve the most important and current facts; drop stale or redundant detail. ' +
      'Stay under ' +
      cap +
      ' characters total.' +
      footer
    );
  }

  if (kind === 'yasmin') {
    return (
      "Compact Yasmin's own self-reflection below into a short first-person summary of her preferences, " +
      'personality, and current state. Use first-person voice ("I like...", "My..."). No section headings ' +
      'are required. Stay under ' +
      cap +
      ' characters total.' +
      footer
    );
  }

  return (
    'Compact the family-wide notes below (traditions, inside jokes, shared rules) into a short summary. No ' +
    'section headings are required. Stay under ' +
    cap +
    ' characters total.' +
    footer
  );
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
    inputs: [{ role: 'user', content: compactPrompt(kind, personName, strippedContent) }]
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
    inputs: [{ role: 'user', content: tighterPrompt }]
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
