import { config } from './config';
import {
  askAgent,
  deleteConversation,
  getConversationMessages,
  ConversationMessage
} from './mistral/mistral_api';
import { extractMessageText, isDialogueMessage } from './nightly/reflection';
import { PREVIOUS_CONVERSATION_CAPTURE_RE, SUMMARY_CAPTURE_RE, cleanStoredText, xmlBlock } from './protocol';
import { stripChannelHistoryBlock } from './channel_history';

// When a live conversation is restarted (turn limit or poisoned-conversation respawn) the new one has no
// history. The handoff replays a summary of the old conversation plus its last few turns inside a
// <previous_conversation> block on the new conversation's first prompt. The nightly journal strips this
// block (stripHandoffBlock) because the old conversation is journaled on its own.

interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

// User messages are stored with the injected context (entries, manifest, "You are talking to", answer-length
// hint) in front of what the user actually wrote; only the latter is dialogue.
export { cleanStoredText };

const truncate = (text: string, max: number): string => (text.length > max ? text.slice(0, max) + '…' : text);

/** Returns the dialogue turns of a conversation, plus the previous handoff block it was seeded with (if any) */
export const extractTurns = (messages: ConversationMessage[]): { turns: Turn[]; priorContext?: string } => {
  const turns: Turn[] = [];
  let priorContext: string | undefined;
  for (const message of messages) {
    if (!isDialogueMessage(message)) {
      continue;
    }
    const role: 'user' | 'assistant' =
      message.role === 'user' || (!message.role && !message.type.includes('output')) ? 'user' : 'assistant';
    const raw = extractMessageText(message.content);
    if (role === 'user' && priorContext === undefined) {
      // Strip the channel-history block (untrusted third-party chatter) before capturing prior context, so
      // a <previous_conversation> smuggled into the transcript can never be read as trusted harness input.
      priorContext = PREVIOUS_CONVERSATION_CAPTURE_RE.exec(stripChannelHistoryBlock(raw))?.[1]?.trim();
    }
    const text = role === 'user' ? cleanStoredText(raw) : raw.trim();
    if (text.length > 0) {
      turns.push({ role, text });
    }
  }
  return { turns, priorContext };
};

/** Splits turns into the older part (to be summarized) and the last N user turns with their replies */
export const splitRecent = (turns: Turn[], recentUserTurns: number): { older: Turn[]; recent: Turn[] } => {
  const userIdx = turns.map((t, i) => (t.role === 'user' ? i : -1)).filter(i => i >= 0);
  const start = userIdx.length > recentUserTurns ? userIdx[userIdx.length - recentUserTurns] : 0;
  return { older: turns.slice(0, start), recent: turns.slice(start) };
};

const renderTurns = (turns: Turn[], maxChars: number): string =>
  turns.map(t => `${t.role}: ${truncate(t.text, maxChars)}`).join('\n');

const formatBlock = (summary: string | undefined, recent: Turn[]): string | undefined => {
  const parts: string[] = [];
  if (summary) {
    parts.push(xmlBlock('summary', truncate(summary.trim(), config.handoff.summaryMaxChars)));
  }
  if (recent.length > 0) {
    parts.push(xmlBlock('recent_messages', renderTurns(recent, config.handoff.recentMessageMaxChars)));
  }
  return parts.length > 0 ? xmlBlock('previous_conversation', parts.join('\n')) : undefined;
};

/** One-shot call to the summarizer agent; the throwaway conversation is never kept */
const summarize = async (input: string): Promise<string | undefined> => {
  const agentId = config.mistral.summarizerAgentId;
  if (!agentId) {
    return undefined;
  }
  const result = await askAgent({
    agentId,
    name: 'handoff-summary',
    inputs: [{ role: 'user', content: truncate(input, config.handoff.summarizerInputMaxChars) }],
    store: false
  });
  // store:false should already prevent persistence; delete anyway so nothing can accumulate.
  await deleteConversation(result.conversationId).catch(() => undefined);
  return result.outputText.trim() || undefined;
};

/**
 * Builds the <previous_conversation> block for a conversation that is about to be replaced.
 * Never throws: any failure degrades to fewer details (last turns only) or no block at all.
 */
export const buildHandoff = async (
  conversationId: string,
  options: { withSummary: boolean } = { withSummary: true }
): Promise<string | undefined> => {
  let turns: Turn[];
  let priorContext: string | undefined;
  try {
    ({ turns, priorContext } = extractTurns(await getConversationMessages(conversationId)));
  } catch (error) {
    console.error(`WARN Handoff: could not read conversation ${conversationId}: ${error}`);
    return undefined;
  }

  const { older, recent } = splitRecent(turns, config.mistral.handoffRecentTurns);

  let summary: string | undefined;
  if (options.withSummary && (older.length > 0 || priorContext)) {
    const input =
      (priorContext ? `Earlier context (from before this conversation started):\n${priorContext}\n\n` : '') +
      `Conversation to summarize:\n${renderTurns(older, config.handoff.summarizerTurnMaxChars)}`;
    try {
      summary = await summarize(input);
    } catch (error) {
      console.error(`WARN Handoff: summarizing ${conversationId} failed, using last turns only: ${error}`);
    }
  }
  // Without a fresh summary keep the previous one so a chained restart does not lose the thread.
  if (!summary && priorContext) {
    summary = SUMMARY_CAPTURE_RE.exec(priorContext)?.[1]?.trim();
  }
  return formatBlock(summary, recent);
};

/** Resolves with the promise's value, or undefined if it takes longer than ms or rejects */
export const waitFor = async <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), ms);
      })
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};
