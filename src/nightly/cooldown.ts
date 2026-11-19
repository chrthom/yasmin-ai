import { config } from '../config';
import { MemoryArchiveRow } from '../database/models/memory_archive.model';
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
 * Extracts the distinct calendar dates (YYYY-MM-DD in MEMORY_TZ) on which the given person had at
 * least one non-empty archived conversation journal. Multiple conversations on the same day count
 * as a single active conversation day; dreams and other people's journals are ignored.
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
    if (rest.includes('/') || row.content.trim().length === 0) {
      continue;
    }
    dates.add(formatCooldownDate(row.createdAt));
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
 * Groups a section's body lines into blank-line runs and logical items (bullets together with any
 * indented continuation lines or nested sub-bullets, or single unbulleted lines).
 *
 * @param bodyLines The lines inside one `## ` section.
 * @returns Ordered blank and item chunks.
 */
function parseBodyChunks(bodyLines: string[]): BodyChunk[] {
  const chunks: BodyChunk[] = [];
  let activeItem: { lines: string[]; baseIndent: number; isList: boolean } | null = null;

  for (const line of bodyLines) {
    if (line.trim().length === 0) {
      if (activeItem) {
        chunks.push({ type: 'item', lines: activeItem.lines });
        activeItem = null;
      }
      const prev = chunks[chunks.length - 1];
      if (prev && prev.type === 'blank') {
        prev.lines.push(line);
      } else {
        chunks.push({ type: 'blank', lines: [line] });
      }
      continue;
    }

    const indent = leadingIndent(line);
    const listMatch = LIST_ITEM_START_RE.exec(line);

    if (activeItem && indent > activeItem.baseIndent) {
      // Indented continuation line or nested sub-bullet belongs to the current parent item.
      activeItem.lines.push(line);
      continue;
    }

    if (activeItem) {
      chunks.push({ type: 'item', lines: activeItem.lines });
    }

    activeItem = {
      lines: [line],
      baseIndent: listMatch ? listMatch[1].length : indent,
      isList: listMatch !== null
    };
  }

  if (activeItem) {
    chunks.push({ type: 'item', lines: activeItem.lines });
  }

  return chunks;
}

/**
 * Collects all regex capture-group-1 matches from text without mutating shared RegExp state.
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
 * its two overrides (`neuer Aspekt` >= `besprochen` date, or a `fällig ab` date reached since the
 * discussion).
 *
 * @param itemLines Lines belonging to a single bullet or paragraph item.
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
  const itemText = itemLines.join('\n');
  const besprochenDates = collectDates(BESPROCHEN_TAG_RE, itemText, 2);
  if (besprochenDates.length === 0) {
    return itemLines;
  }

  const besprochenDate = besprochenDates.reduce((max, d) => (d > max ? d : max));
  const neuerAspektDates = collectDates(NEUER_ASPEKT_DATE_RE, itemText, 1);
  const faelligDates = collectDates(FAELLIG_AB_DATE_RE, itemText, 1);

  // Override 1: a new aspect dated on or after the last discussion makes the topic fair game again.
  const hasFreshNewAspect = neuerAspektDates.some(d => d >= besprochenDate);
  // Override 2: a target date strictly after the discussion that has now arrived lifts cooldown;
  // requiring d > besprochenDate prevents an old pre-discussion deadline from bypassing cooldown.
  const isDueNow = faelligDates.some(d => d > besprochenDate && d <= runDate);

  if (hasFreshNewAspect || isDueNow) {
    return itemLines;
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
