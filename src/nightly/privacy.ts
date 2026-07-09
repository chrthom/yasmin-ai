// Sensitive passages are wrapped as `[PRIVACY:SENSITIVE]\n...\n[/PRIVACY:SENSITIVE]`, one marker per line.

const SENSITIVE_BLOCK_RE = /\[PRIVACY:SENSITIVE\][\s\S]*?\[\/PRIVACY:SENSITIVE\]/g;
const EXCESSIVE_BLANK_LINES_RE = /\n{3,}/g;
const TRUNCATION_MARKER = '…[truncated]';

/**
 * Removes every [PRIVACY:SENSITIVE]...[/PRIVACY:SENSITIVE] block and collapses resulting blank-line gaps
 */
export function stripSensitive(content: string): string {
  if (!content.match(SENSITIVE_BLOCK_RE)) {
    return content;
  }
  return content.replace(SENSITIVE_BLOCK_RE, '').replace(EXCESSIVE_BLANK_LINES_RE, '\n\n');
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
