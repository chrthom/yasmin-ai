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
 * Placeholder written into Open Topics or Yasmin's Intentions when cooldown strips every item in
 * that section, keeping the compaction LLM from back-filling the emptied heading with paused topics.
 */
export const EMPTY_COOLDOWN_SECTION_PLACEHOLDER = '- (aktuell keine)';

const JOURNAL_CHAT_DATES_LINE_RE = /^chatDates:\s*(\d{4}-\d{2}-\d{2}(?:\s*,\s*\d{4}-\d{2}-\d{2})*)\s*$/im;
const JOURNAL_CHAT_DATES_STRIP_RE = /^chatDates:\s*\d{4}-\d{2}-\d{2}(?:\s*,\s*\d{4}-\d{2}-\d{2})*\s*\n+/i;

const FAST_PATH_BESPROCHEN_RE = /\bbesprochen\s+am\s+\d{4}-\d{2}-\d{2}\b/i;
const BESPROCHEN_TAG_RE = /([([,;–-]\s*)(?:zuletzt\s+)?besprochen\s+am\s+(\d{4}-\d{2}-\d{2})\b/gi;
const NEUER_ASPEKT_DATE_RE = /\bneuer\s+Aspekt\s+am\s+(\d{4}-\d{2}-\d{2})\b/gi;
const FAELLIG_AB_DATE_RE = /\bf(?:ä|ae)llig\s+ab\s+(\d{4}-\d{2}-\d{2})\b/gi;

const SIBLING_CLAUSE_BOUNDARY =
  '(?:[,;]\\s*(?:(?:zuletzt\\s+)?besprochen\\s+am\\b|f(?:ä|ae)llig\\s+ab\\b|Status\\s*:))';
const ASPEKT_BODY_CHAR = `(?:(?!${SIBLING_CLAUSE_BOUNDARY})(?:[^()]|\\([^()]*\\)))`;

const STALE_LEADING_ASPEKT_RE = new RegExp(
  `\\(\\s*neuer\\s+Aspekt\\s+am\\s+(\\d{4}-\\d{2}-\\d{2})(?:\\s*[:–-]\\s*${ASPEKT_BODY_CHAR}*)?\\s*[,;]\\s*(?=(?:zuletzt\\s+)?besprochen\\s+am\\b|f(?:ä|ae)llig\\s+ab\\b|Status\\s*:)`,
  'gi'
);
const STALE_TRAILING_ASPEKT_RE = new RegExp(
  `\\s*[,;]\\s*neuer\\s+Aspekt\\s+am\\s+(\\d{4}-\\d{2}-\\d{2})(?:\\s*[:–-]\\s*${ASPEKT_BODY_CHAR}*)?(?=\\s*(?:\\)|${SIBLING_CLAUSE_BOUNDARY}))`,
  'gi'
);
const STALE_STANDALONE_ASPEKT_RE = new RegExp(
  `\\s*\\(neuer\\s+Aspekt\\s+am\\s+(\\d{4}-\\d{2}-\\d{2})(?:\\s*[:–-]\\s*${ASPEKT_BODY_CHAR}*)?\\)`,
  'gi'
);

const SECTION_HEADING_RE = /^##\s+(.+?)\s*$/;
const LIST_ITEM_START_RE = /^(\s*)(?:[-*+]|\d+\.)\s+/;

type SectionKind = 'intentions' | 'open_topics' | 'recent_happenings' | 'other';

interface ParsedSection {
  headingLine: string | null;
  kind: SectionKind;
  bodyLines: string[];
}

interface BodyChunk {
  type: 'blank' | 'item';
  lines: string[];
}

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
 * Classifies a `## Heading` title into the cooldown behavior bucket for that person-profile section.
 *
 * @param rawHeading The heading text after `## `.
 * @returns The section bucket governing stripping vs. tag rewriting.
 */
function classifySection(rawHeading: string): SectionKind {
  const normalized = rawHeading.trim().toLowerCase().replace(/’/g, "'");
  if (normalized === "yasmin's intentions") {
    return 'intentions';
  }
  if (normalized === 'open topics') {
    return 'open_topics';
  }
  if (normalized === 'recent happenings') {
    return 'recent_happenings';
  }
  return 'other';
}

/**
 * Splits a markdown file into its optional preamble and `## ` sections.
 *
 * @param lines The file's lines.
 * @returns Ordered sections with heading metadata and body lines.
 */
function splitIntoSections(lines: string[]): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let current: ParsedSection = { headingLine: null, kind: 'other', bodyLines: [] };

  for (const line of lines) {
    const match = SECTION_HEADING_RE.exec(line);
    if (match) {
      if (current.headingLine !== null || current.bodyLines.length > 0) {
        sections.push(current);
      }
      current = {
        headingLine: line,
        kind: classifySection(match[1]),
        bodyLines: []
      };
    } else {
      current.bodyLines.push(line);
    }
  }

  if (current.headingLine !== null || current.bodyLines.length > 0) {
    sections.push(current);
  }

  return sections;
}

/**
 * Counts the leading spaces/tabs of a line to associate indented continuations and sub-bullets
 * with their parent list item.
 *
 * @param line A single markdown line.
 * @returns Number of leading whitespace characters.
 */
function leadingIndent(line: string): number {
  let count = 0;
  while (count < line.length && (line[count] === ' ' || line[count] === '\t')) {
    count++;
  }
  return count;
}

/**
 * Groups a section's body lines into blank-line runs and logical items. Blank-separated indented
 * continuations and nested sub-bullets stay attached to their parent list item so suppressing a
 * parent bullet never leaves orphaned child lines behind.
 *
 * @param bodyLines The lines inside one `## ` section.
 * @returns Ordered blank and item chunks.
 */
function parseBodyChunks(bodyLines: string[]): BodyChunk[] {
  const chunks: BodyChunk[] = [];
  let activeItem: { lines: string[]; baseIndent: number; isList: boolean } | null = null;
  let pendingBlanks: string[] = [];

  for (const line of bodyLines) {
    if (line.trim().length === 0) {
      if (activeItem) {
        pendingBlanks.push(line);
      } else {
        const prev = chunks[chunks.length - 1];
        if (prev && prev.type === 'blank') {
          prev.lines.push(line);
        } else {
          chunks.push({ type: 'blank', lines: [line] });
        }
      }
      continue;
    }

    const indent = leadingIndent(line);
    const listMatch = LIST_ITEM_START_RE.exec(line);

    if (
      activeItem &&
      activeItem.isList &&
      (indent > activeItem.baseIndent || (pendingBlanks.length === 0 && listMatch === null))
    ) {
      // Indented continuation paragraph / nested sub-bullet (even after blank lines), or an
      // immediate lazy continuation line with no intervening blank line, stays attached to the
      // current parent list item.
      if (pendingBlanks.length > 0) {
        activeItem.lines.push(...pendingBlanks);
        pendingBlanks = [];
      }
      activeItem.lines.push(line);
      continue;
    }

    if (activeItem) {
      chunks.push({ type: 'item', lines: activeItem.lines });
      if (pendingBlanks.length > 0) {
        chunks.push({ type: 'blank', lines: pendingBlanks });
        pendingBlanks = [];
      }
    }

    activeItem = {
      lines: [line],
      baseIndent: listMatch ? listMatch[1].length : indent,
      isList: listMatch !== null
    };
  }

  if (activeItem) {
    chunks.push({ type: 'item', lines: activeItem.lines });
    if (pendingBlanks.length > 0) {
      chunks.push({ type: 'blank', lines: pendingBlanks });
    }
  }

  return chunks;
}

/**
 * Collects all regex capture-group matches from text without mutating shared RegExp state.
 *
 * @param pattern Global regex whose capture group index provides the date string.
 * @param text The item text to inspect.
 * @param groupIndex Capture group index holding the YYYY-MM-DD date.
 * @returns All matched YYYY-MM-DD strings.
 */
function collectDates(pattern: RegExp, text: string, groupIndex: number): string[] {
  const regex = new RegExp(pattern.source, pattern.flags);
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    results.push(match[groupIndex]);
  }
  return results;
}

/**
 * Removes stale `neuer Aspekt am <date>` annotations that predate `besprochenDate`, so an already-
 * discussed aspect does not linger as if it were still new.
 *
 * @param text The item text to clean.
 * @param besprochenDate The latest discussed date on the item.
 * @returns The item text with pre-discussion `neuer Aspekt` clauses removed.
 */
function stripStaleNewAspectTags(text: string, besprochenDate: string): string {
  return text
    .replace(STALE_LEADING_ASPEKT_RE, (full, date: string) => (date < besprochenDate ? '(' : full))
    .replace(STALE_TRAILING_ASPEKT_RE, (full, date: string) => (date < besprochenDate ? '' : full))
    .replace(STALE_STANDALONE_ASPEKT_RE, (full, date: string) => (date < besprochenDate ? '' : full));
}

/**
 * Removes deadline annotations already covered by the latest discussion from the compaction view,
 * so the live agent cannot treat an expired `fällig ab` date as a cooldown override.
 *
 * @param text The item text to clean.
 * @param besprochenDate The latest discussed date on the item.
 * @returns Text without deadlines on or before the latest discussion.
 */
function stripStaleDueTags(text: string, besprochenDate: string): string {
  return text
    .replace(/\s*\(\s*f(?:ä|ae)llig\s+ab\s+(\d{4}-\d{2}-\d{2})\s*\)/gi, (full, date: string) =>
      date <= besprochenDate ? '' : full
    )
    .replace(/\(\s*f(?:ä|ae)llig\s+ab\s+(\d{4}-\d{2}-\d{2})\s*[,;]\s*/gi, (full, date: string) =>
      date <= besprochenDate ? '(' : full
    )
    .replace(/\s*[,;]\s*f(?:ä|ae)llig\s+ab\s+(\d{4}-\d{2}-\d{2})\b/gi, (full, date: string) =>
      date <= besprochenDate ? '' : full
    )
    .replace(FAELLIG_AB_DATE_RE, (full, date: string) =>
      date <= besprochenDate ? 'keine offene Fälligkeit' : full
    );
}

/**
 * Rewrites `(besprochen am YYYY-MM-DD)` on an item that carries a future `fällig ab` deadline into
 * explicit date-gated restraint guidance, keeping the item in the eager cache so the live agent can
 * still act on the deadline when it arrives after quiet nights (when Phases 2-9 do not re-run).
 *
 * @param itemText The item text to rewrite.
 * @param besprochenDate The latest discussed date on the item.
 * @param dueDate The earliest future post-discussion `fällig ab` date (YYYY-MM-DD).
 * @returns The item text with deadline-gated restraint guidance.
 */
function rewriteFutureDueTag(itemText: string, besprochenDate: string, dueDate: string): string {
  const cleaned = stripStaleNewAspectTags(itemText, besprochenDate);
  const regex = new RegExp(BESPROCHEN_TAG_RE.source, BESPROCHEN_TAG_RE.flags);

  return cleaned.replace(
    regex,
    (_full, prefix: string, date: string) =>
      `${prefix}am ${date} besprochen – Zurückhaltung bis ${dueDate}, erst ab Fälligkeit oder bei neuem Aspekt von selbst ansprechen`
  );
}

/**
 * Rewrites `(besprochen am YYYY-MM-DD)` tags on a kept item into the human-readable guidance the
 * compaction and live-chat agents consume for the current active-day distance.
 *
 * @param itemText The item text to rewrite.
 * @param besprochenDate The latest discussed date on the item.
 * @param subsequentActiveDays Active conversation days for this person strictly after `besprochenDate`.
 * @returns The rewritten item text.
 */
function rewriteBesprochenTag(
  itemText: string,
  besprochenDate: string,
  subsequentActiveDays: number
): string {
  const cleaned = stripStaleNewAspectTags(itemText, besprochenDate);
  const regex = new RegExp(BESPROCHEN_TAG_RE.source, BESPROCHEN_TAG_RE.flags);

  return cleaned.replace(regex, (_full, prefix: string, date: string) => {
    if (subsequentActiveDays === 0) {
      return (
        prefix +
        'zuletzt im letzten Gespräch besprochen – Pause, nicht von selbst anfangen außer bei neuem Aspekt'
      );
    }
    if (subsequentActiveDays < COOLDOWN_ACTIVE_DAYS) {
      const dayLabel =
        subsequentActiveDays === 1 ? '1 Gesprächstag' : `${subsequentActiveDays} Gesprächstagen`;
      return prefix + `vor ${dayLabel} besprochen – Zurückhaltung, nur bei neuem Aspekt`;
    }
    return prefix + `am ${date}`;
  });
}

/**
 * Evaluates one item inside a person-profile section against the 5-active-chat-day cooldown and
 * its overrides (`neuer Aspekt` >= `besprochen` date, reached `fällig ab` date, or retained
 * deadline-gated restraint for a future `fällig ab` date).
 *
 * @param itemLines Lines belonging to a single bullet (plus any continuations/sub-bullets) or paragraph.
 * @param sectionKind Section bucket governing whether cooldown strips or rewrites the item.
 * @param activeChatDates Set of active conversation dates (YYYY-MM-DD) for this person.
 * @param runDate Current nightly run date (YYYY-MM-DD in MEMORY_TZ).
 * @returns Kept (possibly rewritten) lines, or null when the item is stripped by cooldown.
 */
function transformItem(
  itemLines: string[],
  sectionKind: SectionKind,
  activeChatDates: ReadonlySet<string>,
  runDate: string
): string[] | null {
  const rawItemText = itemLines.join('\n');
  const besprochenDates = collectDates(BESPROCHEN_TAG_RE, rawItemText, 2);
  if (besprochenDates.length === 0) {
    return itemLines;
  }

  const besprochenDate = besprochenDates.reduce((max, d) => (d > max ? d : max));
  const itemText = stripStaleDueTags(rawItemText, besprochenDate);
  const neuerAspektDates = collectDates(NEUER_ASPEKT_DATE_RE, itemText, 1);
  const faelligDates = collectDates(FAELLIG_AB_DATE_RE, itemText, 1);

  // Override 1: a new aspect dated on or after the last discussion makes the topic fair game again.
  const hasFreshNewAspect = neuerAspektDates.some(d => d >= besprochenDate);
  // Override 2a: a post-discussion target date that has arrived lifts cooldown immediately;
  // requiring d > besprochenDate prevents an old pre-discussion deadline from bypassing cooldown.
  const isDueNow = faelligDates.some(d => d > besprochenDate && d <= runDate);

  if (hasFreshNewAspect || isDueNow) {
    return itemText.split('\n');
  }

  // Override 2b: a future post-discussion target date must NOT be stripped from the eager cache,
  // because quiet nights skip Phases 2-9 -- keep it with explicit date-gated restraint so the live
  // agent holds back before dueDate and can act once today >= dueDate even without another run.
  const futureDueDates = faelligDates.filter(d => d > besprochenDate && d > runDate);
  if (futureDueDates.length > 0) {
    const earliestFutureDue = futureDueDates.reduce((min, d) => (d < min ? d : min));
    return rewriteFutureDueTag(itemText, besprochenDate, earliestFutureDue).split('\n');
  }

  let subsequentActiveDays = 0;
  for (const chatDate of activeChatDates) {
    if (chatDate > besprochenDate) {
      subsequentActiveDays++;
    }
  }

  if (subsequentActiveDays === 0 && (sectionKind === 'intentions' || sectionKind === 'open_topics')) {
    return null;
  }
  if (
    subsequentActiveDays > 0 &&
    subsequentActiveDays < COOLDOWN_ACTIVE_DAYS &&
    sectionKind === 'intentions'
  ) {
    return null;
  }

  return rewriteBesprochenTag(itemText, besprochenDate, subsequentActiveDays).split('\n');
}

/**
 * Reassembles a section's lines after item transformation. When no items were stripped, original
 * blank-line runs stay byte-identical; when items were stripped, redundant blank runs collapse and
 * an emptied Open Topics / Yasmin's Intentions section receives a placeholder line.
 *
 * @param section The parsed section.
 * @param activeChatDates Active conversation dates for this person.
 * @param runDate Current nightly run date (YYYY-MM-DD).
 * @returns Reassembled lines (including heading line when present).
 */
function transformSection(
  section: ParsedSection,
  activeChatDates: ReadonlySet<string>,
  runDate: string
): string[] {
  const headerLines = section.headingLine !== null ? [section.headingLine] : [];
  if (section.kind === 'recent_happenings') {
    return [...headerLines, ...section.bodyLines];
  }

  const sectionText = section.bodyLines.join('\n');
  if (!FAST_PATH_BESPROCHEN_RE.test(sectionText)) {
    return [...headerLines, ...section.bodyLines];
  }

  const chunks = parseBodyChunks(section.bodyLines);
  let strippedAny = false;
  let hadItems = false;
  const keptItemChunks: string[][] = [];
  const inPlaceChunks: string[][] = [];

  for (const chunk of chunks) {
    if (chunk.type === 'blank') {
      inPlaceChunks.push(chunk.lines);
      continue;
    }
    hadItems = true;
    const transformed = transformItem(chunk.lines, section.kind, activeChatDates, runDate);
    if (transformed === null) {
      strippedAny = true;
    } else {
      keptItemChunks.push(transformed);
      inPlaceChunks.push(transformed);
    }
  }

  if (!strippedAny) {
    return [...headerLines, ...inPlaceChunks.flat()];
  }

  const hasLeadingBlank = chunks.length > 0 && chunks[0].type === 'blank';
  const hasTrailingBlank = chunks.length > 0 && chunks[chunks.length - 1].type === 'blank';
  const hadBlankBetweenItems = chunks.some(
    (chunk, idx) => chunk.type === 'blank' && idx > 0 && idx < chunks.length - 1
  );

  const rebuiltBody: string[] = [];
  if (hasLeadingBlank) {
    rebuiltBody.push('');
  }

  if (hadItems && keptItemChunks.length === 0) {
    rebuiltBody.push(EMPTY_COOLDOWN_SECTION_PLACEHOLDER);
  } else {
    keptItemChunks.forEach((itemLines, idx) => {
      if (idx > 0 && hadBlankBetweenItems) {
        rebuiltBody.push('');
      }
      rebuiltBody.push(...itemLines);
    });
  }

  if (hasTrailingBlank) {
    rebuiltBody.push('');
  }

  return [...headerLines, ...rebuiltBody];
}

/**
 * Applies deterministic per-person topic cooldown to a privacy-stripped `people/<name>.md` source
 * before Phase-7 eager-cache compaction. Never modifies `memory_archive` -- the archived file keeps
 * its static `(besprochen am YYYY-MM-DD)` dates so quiet nights cause zero version or upload churn.
 *
 * @param content Privacy-stripped `people/<name>.md` content.
 * @param activeChatDates Distinct YYYY-MM-DD dates on which this person had a conversation.
 * @param runDate Current nightly run date (YYYY-MM-DD in MEMORY_TZ).
 * @returns Transformed markdown ready for `runCompact('person', ...)`.
 */
export function applyPersonTopicCooldown(
  content: string,
  activeChatDates: ReadonlySet<string>,
  runDate: string
): string {
  if (!FAST_PATH_BESPROCHEN_RE.test(content)) {
    return content;
  }

  const normalized = content.replace(/\r\n/g, '\n');
  const sections = splitIntoSections(normalized.split('\n'));
  const outputLines = sections.flatMap(section => transformSection(section, activeChatDates, runDate));
  return outputLines.join('\n');
}
