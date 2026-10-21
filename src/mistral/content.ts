/**
 * Joins the text parts of a message's content, which Mistral sends either as a plain string or
 * as an array of `{type, text}` parts. Single source of truth for this content shape -- used by
 * the live agent (chat_agent.ts), the agent-based nightly pipeline (mistral_api.ts) and the
 * reflection/handoff code.
 *
 * @param content A message content of unknown shape (string, part array, or anything else).
 * @returns The concatenated text parts, or an empty string for any other shape.
 */
export function extractContentText(content: unknown): string {
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
