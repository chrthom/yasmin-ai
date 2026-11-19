import { config } from '../config';
import { MemoryArchiveRow } from '../database/models/memory_archive.model';
import { ConversationMessage } from '../mistral/mistral_api';
import { dreamDateFromPath } from './dream';

/**
 * Subsequent active conversation days with a person required before a discussed topic's cooldown
 * lifts completely. Days without a conversation for that specific person do not advance cooldown.
 */
export const COOLDOWN_ACTIVE_DAYS = 5;

/**
 * Maximum recent active conversation dates rendered into the Phase-7 person compaction prompt.
 * Keeping `2 * COOLDOWN_ACTIVE_DAYS` dates preserves exact `0..4` vs. `>= 5` counts for every
 * discussion date while bounding prompt size over years of archived journals.
 */
const MAX_PROMPT_ACTIVE_DATES = COOLDOWN_ACTIVE_DAYS * 2;

const JOURNAL_CHAT_DATES_LINE_RE = /^chatDates:\s*(\d{4}-\d{2}-\d{2}(?:\s*,\s*\d{4}-\d{2}-\d{2})*)\s*$/im;
const JOURNAL_CHAT_DATES_STRIP_RE = /^chatDates:\s*\d{4}-\d{2}-\d{2}(?:\s*,\s*\d{4}-\d{2}-\d{2})*\s*\n+/i;

/**
 * Formats an instant as YYYY-MM-DD in the configured nightly memory timezone (defaulting to
 * Europe/Berlin when unset in unit-test mocks).
 *
 * @param date The instant to format.
 * @returns The YYYY-MM-DD calendar date in MEMORY_TZ.
 */
export function formatCooldownDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.nightly?.tz || 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

/**
 * Checks whether a raw Mistral conversation message is a human user turn (excluding assistant
 * outputs and internal tool/function/system/service/error rows).
 *
 * @param message Raw conversation message row.
 * @returns true when the message represents a user turn.
 */
function isUserTurnMessage(message: ConversationMessage): boolean {
  const t = message.type.toLowerCase();
  if (
    t.includes('tool') ||
    t.includes('function') ||
    t.includes('system') ||
    t.includes('service') ||
    t.includes('error')
  ) {
    return false;
  }
  const role = message.role ? message.role.toLowerCase() : t.includes('output') ? 'assistant' : 'user';
  return role === 'user';
}

/**
 * Extracts sorted, deduplicated YYYY-MM-DD calendar dates (in MEMORY_TZ) of all user messages in a
 * conversation. When a non-empty message list lacks per-message timestamps, falls back to the
 * conversation's `updatedAt` timestamp so delayed consolidation runs still record the chat's date.
 *
 * @param messages Raw conversation messages returned by Mistral.
 * @param fallbackUpdatedAt Optional conversation `updated_at` ISO timestamp.
 * @returns Sorted distinct YYYY-MM-DD dates on which the user wrote in this conversation.
 */
export function extractConversationUserDates(
  messages: readonly ConversationMessage[],
  fallbackUpdatedAt?: string
): string[] {
  if (messages.length === 0) {
    return [];
  }

  const dates = new Set<string>();
  for (const message of messages) {
    if (!isUserTurnMessage(message) || !message.createdAt) {
      continue;
    }
    const parsed = new Date(message.createdAt);
    if (!isNaN(parsed.getTime())) {
      dates.add(formatCooldownDate(parsed));
    }
  }

  if (dates.size === 0 && fallbackUpdatedAt) {
    const parsedFallback = new Date(fallbackUpdatedAt);
    if (!isNaN(parsedFallback.getTime())) {
      dates.add(formatCooldownDate(parsedFallback));
    }
  }

  return [...dates].sort();
}

/**
 * Strips any leading `chatDates: ...` metadata header from an archived journal entry, returning
 * just the prose body.
 *
 * @param content Raw archived journal content.
 * @returns Journal content without the `chatDates:` header.
 */
export function stripJournalChatDates(content: string): string {
  return content.replace(JOURNAL_CHAT_DATES_STRIP_RE, '');
}

/**
 * Parses the `chatDates: YYYY-MM-DD, ...` header written at the top of archived conversation
 * journals by Phase 2.
 *
 * @param content Raw archived journal content.
 * @returns Sorted distinct YYYY-MM-DD dates from the header, or `[]` when absent.
 */
export function parseJournalChatDates(content: string): string[] {
  const match = JOURNAL_CHAT_DATES_LINE_RE.exec(content);
  if (!match) {
    return [];
  }
  const dates = new Set(
    match[1]
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
  );
  return [...dates].sort();
}

/**
 * Prepends the authoritative `chatDates: YYYY-MM-DD, ...` header to a non-empty journal entry so
 * multi-day conversations and multi-day backlogs consolidated in a single nightly run preserve
 * their real user-message calendar dates.
 *
 * @param journalText Generated journal prose.
 * @param chatDates Distinct YYYY-MM-DD user-message dates for the conversation.
 * @returns Journal content with the `chatDates:` header when both prose and dates are non-empty.
 */
export function stampJournalChatDates(journalText: string, chatDates: readonly string[]): string {
  const body = stripJournalChatDates(journalText).trim();
  if (body.length === 0 || chatDates.length === 0) {
    return journalText;
  }
  const uniqueSorted = [...new Set(chatDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  if (uniqueSorted.length === 0) {
    return journalText;
  }
  return `chatDates: ${uniqueSorted.join(', ')}\n\n${body}`;
}

/**
 * Extracts the distinct calendar dates (YYYY-MM-DD in MEMORY_TZ) on which the given person had at
 * least one non-empty archived conversation journal. Prefers each journal's persisted `chatDates:`
 * user-message dates (handling multi-day chats and backlog recovery runs), falling back to
 * `row.createdAt` only for legacy journals archived without the header. Dreams and other people's
 * journals are ignored.
 *
 * @param currentVersions All current memory_archive rows.
 * @param personSlug The sanitized person path slug (e.g. "zara" or "mary-jane").
 * @returns Set of distinct YYYY-MM-DD dates with active conversations for that person.
 */
export function extractPersonActiveChatDates(
  currentVersions: readonly MemoryArchiveRow[],
  personSlug: string
): Set<string> {
  const prefix = 'journals/' + personSlug + '/';
  const dates = new Set<string>();

  for (const row of currentVersions) {
    if (!row.filePath.startsWith(prefix) || !row.filePath.endsWith('.md')) {
      continue;
    }
    if (dreamDateFromPath(row.filePath) !== null) {
      continue;
    }
    const rest = row.filePath.slice(prefix.length);
    if (rest.includes('/') || stripJournalChatDates(row.content).trim().length === 0) {
      continue;
    }

    const persistedDates = parseJournalChatDates(row.content);
    if (persistedDates.length > 0) {
      for (const d of persistedDates) {
        dates.add(d);
      }
    } else {
      dates.add(formatCooldownDate(row.createdAt));
    }
  }

  return dates;
}

/**
 * Formats a person's distinct active conversation dates into a compact, chronologically sorted
 * summary for the Phase-7 person compaction prompt.
 *
 * @param activeChatDates Distinct YYYY-MM-DD active chat dates for that person.
 * @returns Comma-separated recent dates (or `(none recorded yet)` when empty).
 */
export function formatActiveChatDatesForPrompt(activeChatDates: Iterable<string>): string {
  const sorted = [...new Set([...activeChatDates].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  if (sorted.length === 0) {
    return '(none recorded yet)';
  }
  if (sorted.length <= MAX_PROMPT_ACTIVE_DATES) {
    return sorted.join(', ');
  }
  const recent = sorted.slice(-MAX_PROMPT_ACTIVE_DATES);
  const omitted = sorted.length - recent.length;
  return `${recent.join(', ')} (plus ${omitted} earlier active chat days)`;
}
