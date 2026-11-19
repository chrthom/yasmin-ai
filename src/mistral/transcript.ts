import type { ConversationMessage } from './mistral_api';

/**
 * Checks whether a message row is actual human<->assistant dialogue rather than internal plumbing.
 * Tool and function calls/results, system/service rows and errors must not enter transcripts.
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
