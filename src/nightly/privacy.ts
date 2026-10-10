// Sensitive passages are wrapped as `[PRIVACY:SENSITIVE]\n...\n[/PRIVACY:SENSITIVE]`, one marker per line.

const SENSITIVE_OPEN = '[PRIVACY:SENSITIVE]';
const SENSITIVE_CLOSE = '[/PRIVACY:SENSITIVE]';
const SENSITIVE_BLOCK_RE = /\[PRIVACY:SENSITIVE\][\s\S]*?\[\/PRIVACY:SENSITIVE\]/g;
const EXCESSIVE_BLANK_LINES_RE = /\n{3,}/g;
const TRUNCATION_MARKER = '…[truncated]';

const ARCHIVE_HEADING_RE = /^##\s*Archiv\s*$/im;

/**
 * Removes a trailing "## Archiv" section (decayed facts) from verbose memory content, so the
 * eager-cache compaction never carries archived facts back into the live profile -- regardless
 * of whether the compaction model complies with its prompt instruction to omit the section.
 * Only a heading at the very top level (## , not ###) qualifies; the earliest such heading wins,
 * which also drops an Archiv section that is the last heading by construction of the templates.
 */
export function stripArchiveSection(content: string): string {
  const match = ARCHIVE_HEADING_RE.exec(content);
  if (match === null) {
    return content;
  }
  return content.slice(0, match.index).trimEnd();
}

/**
 * Removes every [PRIVACY:SENSITIVE]...[/PRIVACY:SENSITIVE] block and collapses resulting blank-line gaps.
 *
 * Fails closed on malformed markers: a dangling opener with no matching close (e.g. a truncated
 * response) strips everything from the opener to the end of the content, and a stray closer with no
 * matching opener strips everything from the start of the content through the closer. Either case
 * means we can no longer be sure where the sensitive region was meant to end, so the ambiguous region
 * is dropped rather than risking a leak.
 */
export function stripSensitive(content: string): string {
  if (!content.includes(SENSITIVE_OPEN) && !content.includes(SENSITIVE_CLOSE)) {
    return content;
  }

  let result = content.replace(SENSITIVE_BLOCK_RE, '');

  const openIdx = result.indexOf(SENSITIVE_OPEN);
  if (openIdx !== -1) {
    console.error(
      'WARN privacy: dangling ' +
        SENSITIVE_OPEN +
        ' opener with no matching close; stripping to end of content'
    );
    result = result.slice(0, openIdx);
  }

  const closeIdx = result.indexOf(SENSITIVE_CLOSE);
  if (closeIdx !== -1) {
    console.error(
      'WARN privacy: stray ' +
        SENSITIVE_CLOSE +
        ' closer with no matching open; stripping from start of content'
    );
    result = result.slice(closeIdx + SENSITIVE_CLOSE.length);
  }

  return result.replace(EXCESSIVE_BLANK_LINES_RE, '\n\n');
}

/**
 * Checks whether content exceeds the given character cap
 */
export function isOverCap(content: string, maxChars: number): boolean {
  return content.length > maxChars;
}

/**
 * Truncates content to fit within maxChars (including the trailing "…[truncated]" marker)
 */
export function truncateToCap(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  const sliceLength = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  return content.slice(0, sliceLength) + TRUNCATION_MARKER;
}
