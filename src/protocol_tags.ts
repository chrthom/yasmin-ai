/**
 * Single source of truth for the names of every XML protocol tag the harness itself can inject
 * into a prompt. protocol.ts builds its block/capture regexes from these names and
 * channel_history.ts neutralizes them inside untrusted channel transcripts, so the two can never
 * drift apart.
 */
export const PROTOCOL_TAG = {
  contextEntry: 'context_entry',
  availableContextEntries: 'available_context_entries',
  previousConversation: 'previous_conversation',
  notes: 'nachrichten_fuer_dich',
  summary: 'summary',
  recentMessages: 'recent_messages'
} as const;

export const PROTOCOL_TAG_NAMES: readonly string[] = Object.values(PROTOCOL_TAG);
