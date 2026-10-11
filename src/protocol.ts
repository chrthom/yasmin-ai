import { config } from './config';

/**
 * Single source of truth for the XML protocol tags the live agent injects into user prompts,
 * plus the strip/cleanup regexes built from those names. Prompt strings and their matching
 * cleanup regexes must never drift apart, so they are always derived from the names here.
 */

const TAG = {
  contextEntry: 'context_entry',
  availableContextEntries: 'available_context_entries',
  previousConversation: 'previous_conversation',
  notes: 'nachrichten_fuer_dich',
  summary: 'summary',
  recentMessages: 'recent_messages'
} as const;

/** Matches a full `<tag ...>...</tag>` block (non-greedy, attributes tolerated). */
const blockRegex = (tag: string): RegExp => new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'g');

/** Captures the inner content of a single `<tag>...</tag>` block (first match). */
const captureRegex = (tag: string): RegExp => new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);

export const CONTEXT_ENTRY_BLOCK_RE = blockRegex(TAG.contextEntry);
export const AVAILABLE_CONTEXT_ENTRIES_BLOCK_RE = blockRegex(TAG.availableContextEntries);
export const PREVIOUS_CONVERSATION_BLOCK_RE = blockRegex(TAG.previousConversation);
// Non-global twin for one-shot captures: a /g regex would carry lastIndex between exec() calls.
export const PREVIOUS_CONVERSATION_CAPTURE_RE = captureRegex(TAG.previousConversation);
/** Strip form with trailing whitespace, for transcript cleanup in the nightly journal. */
export const PREVIOUS_CONVERSATION_STRIP_RE = new RegExp(
  `<${TAG.previousConversation}>[\\s\\S]*?<\\/${TAG.previousConversation}>\\s*`,
  'g'
);
export const SUMMARY_CAPTURE_RE = captureRegex(TAG.summary);

/** Wraps content in the given protocol tag, optionally with attributes. */
export const xmlBlock = (tag: string, content: string, attributes?: Record<string, string>): string => {
  const attrs = attributes
    ? ' ' +
      Object.entries(attributes)
        .map(([key, value]) => `${key}="${value}"`)
        .join(' ')
    : '';
  return `<${tag}${attrs}>\n${content}\n</${tag}>`;
};

/** Wraps a context entry title + content into `<context_entry title="...">...</context_entry>`. */
export const contextEntryBlock = (title: string, content: string): string =>
  xmlBlock(TAG.contextEntry, content, { title });

/** Wraps the note lines delivered with a user's input into a `<nachrichten_fuer_dich>` block. */
export const notesBlock = (lines: string[]): string => xmlBlock(TAG.notes, lines.join('\n'));

/** Builds the short-answer constraint appended to the prompt when the requesting client asks for it. */
export const shortAnswerHint = (): string =>
  `Your answer must be shorter than ${config.chat.shortAnswerMaxChars} characters.`;

/**
 * Removes everything the harness (not the user) injected into a stored user message: handoff
 * blocks, context entries, the title manifest, the "You are talking to" line, and the
 * short-answer hint built by shortAnswerHint() -- the hint regex is built from the same
 * config value (escaped), so prompt and cleanup can no longer drift apart.
 */
export const cleanStoredText = (text: string): string =>
  text
    .replace(PREVIOUS_CONVERSATION_BLOCK_RE, '')
    .replace(AVAILABLE_CONTEXT_ENTRIES_BLOCK_RE, '')
    .replace(CONTEXT_ENTRY_BLOCK_RE, '')
    .replace(/^You are talking to .*\.$/m, '')
    .replace(
      new RegExp(`Your answer must be shorter than ${config.chat.shortAnswerMaxChars} characters\\.`, 'g'),
      ''
    )
    .trim();
