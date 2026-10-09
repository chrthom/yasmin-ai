// Shared shape of the <channel_history> block the group/slash controllers prepend to a prompt so the
// agent sees the recent channel conversation. The block is ephemeral request context: the nightly
// journal (buildTranscript) and the handoff (cleanStoredText) must strip it, so the tag name lives here
// as the single source of truth for both the emitting controller and the stripping code.
export const CHANNEL_HISTORY_TAG = 'channel_history';

export const CHANNEL_HISTORY_BLOCK_RE = new RegExp(
  `<${CHANNEL_HISTORY_TAG}>[\\s\\S]*?<\\/${CHANNEL_HISTORY_TAG}>\\s*`,
  'g'
);

export const escapeChannelHistory = (text: string): string =>
  text
    .replaceAll(`<${CHANNEL_HISTORY_TAG}>`, `<${CHANNEL_HISTORY_TAG} >`)
    .replaceAll(`</${CHANNEL_HISTORY_TAG}>`, `< /${CHANNEL_HISTORY_TAG}>`);

export const buildChannelHistoryBlock = (transcript: string): string =>
  `<${CHANNEL_HISTORY_TAG}>\n${escapeChannelHistory(transcript)}\n</${CHANNEL_HISTORY_TAG}>`;

export const stripChannelHistoryBlock = (text: string): string =>
  text.replace(CHANNEL_HISTORY_BLOCK_RE, '').trim();
