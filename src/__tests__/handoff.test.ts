import { buildHandoff, cleanStoredText, extractTurns, splitRecent, waitFor } from '../handoff';
import { askAgent, deleteConversation, getConversationMessages } from '../mistral/mistral_api';
import { config } from '../config';
import { stripHandoffBlock, buildTranscript } from '../nightly/reflection';

jest.mock('../mistral/mistral_api', () => ({
  ...jest.requireActual('../mistral/mistral_api'),
  askAgent: jest.fn(),
  deleteConversation: jest.fn(),
  getConversationMessages: jest.fn()
}));

// config is typed read-only; tests flip the summarizer agent id on and off
const setAgent = (id: string): void => {
  (config.mistral as { summarizerAgentId: string }).summarizerAgentId = id;
};
const mockAsk = askAgent as jest.Mock;
const mockDelete = deleteConversation as jest.Mock;
const mockMessages = getConversationMessages as jest.Mock;

const msg = (role: 'user' | 'assistant', content: string) => ({
  type: role === 'user' ? 'message.input' : 'message.output',
  role,
  content
});

const userWithContext = (text: string) =>
  '<context_entry title="Profile of Zara">\nfacts\n</context_entry>\n\n' +
  '<available_context_entries>\n- Profile of Anna\n</available_context_entries>\n\n' +
  `You are talking to Zara.\n\n${text}\n\nYour answer must be shorter than 1500 characters.`;

describe('handoff', () => {
  const originalAgent = config.mistral.summarizerAgentId;
  beforeEach(() => {
    jest.clearAllMocks();
    setAgent('summarizer-1');
    mockDelete.mockResolvedValue(undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterAll(() => {
    setAgent(originalAgent);
  });

  describe('cleanStoredText', () => {
    it('removes a channel history block', () => {
      const raw = `<channel_history>\nalice: hi\n</channel_history>\n\n${userWithContext('Hello there')}`;
      expect(cleanStoredText(raw)).toBe('Hello there');
    });
    it('removes injected context, manifest, addressing line, length hint and nested handoff', () => {
      const raw = `<previous_conversation>\nold\n</previous_conversation>\n\n${userWithContext('Hello there')}`;
      expect(cleanStoredText(raw)).toBe('Hello there');
    });
  });

  describe('extractTurns / splitRecent', () => {
    it('keeps dialogue only, cleans user text and picks up the prior handoff block', () => {
      const { turns, priorContext } = extractTurns([
        msg(
          'user',
          '<previous_conversation>\n<summary>\nEarlier stuff\n</summary>\n</previous_conversation>\n\nHi'
        ),
        { type: 'function.call', content: 'ignored' },
        msg('assistant', 'Hello!')
      ]);
      expect(turns).toEqual([
        { role: 'user', text: 'Hi' },
        { role: 'assistant', text: 'Hello!' }
      ]);
      expect(priorContext).toContain('Earlier stuff');
    });

    it('splits off the last N user turns together with their replies', () => {
      const turns = [1, 2, 3, 4, 5].flatMap(i => [
        { role: 'user' as const, text: `u${i}` },
        { role: 'assistant' as const, text: `a${i}` }
      ]);
      const { older, recent } = splitRecent(turns, 3);
      expect(older.map(t => t.text)).toEqual(['u1', 'a1', 'u2', 'a2']);
      expect(recent.map(t => t.text)).toEqual(['u3', 'a3', 'u4', 'a4', 'u5', 'a5']);
    });

    it('keeps everything as recent when the conversation is short', () => {
      const turns = [
        { role: 'user' as const, text: 'u1' },
        { role: 'assistant' as const, text: 'a1' }
      ];
      expect(splitRecent(turns, 3)).toEqual({ older: [], recent: turns });
    });
  });

  describe('buildHandoff', () => {
    const longConversation = () =>
      [1, 2, 3, 4, 5].flatMap(i => [
        msg('user', userWithContext(`question ${i}`)),
        msg('assistant', `answer ${i}`)
      ]);

    it('summarizes older turns with store:false, deletes the throwaway conversation and replays recent turns', async () => {
      mockMessages.mockResolvedValue(longConversation());
      mockAsk.mockResolvedValue({ conversationId: 'tmp-1', outputText: 'They discussed topics 1 and 2.' });

      const block = await buildHandoff('conv-1');

      expect(mockAsk).toHaveBeenCalledTimes(1);
      const params = mockAsk.mock.calls[0][0];
      expect(params.agentId).toBe('summarizer-1');
      expect(params.store).toBe(false);
      expect(params.inputs[0].content).toContain('question 1');
      expect(params.inputs[0].content).not.toContain('question 3');
      expect(params.inputs[0].content).not.toContain('context_entry');
      expect(mockDelete).toHaveBeenCalledWith('tmp-1');
      expect(block).toContain('<summary>\nThey discussed topics 1 and 2.\n</summary>');
      expect(block).toContain('user: question 3');
      expect(block).toContain('assistant: answer 5');
      expect(block).not.toContain('question 2');
      expect(block).not.toContain('Profile of Zara');
    });

    it('falls back to the last turns only when the summarizer fails', async () => {
      mockMessages.mockResolvedValue(longConversation());
      mockAsk.mockRejectedValue(new Error('boom'));
      const block = await buildHandoff('conv-1');
      expect(block).not.toContain('<summary>');
      expect(block).toContain('user: question 5');
    });

    it('skips the summarizer when withSummary is false or no agent is configured', async () => {
      mockMessages.mockResolvedValue(longConversation());
      await buildHandoff('conv-1', { withSummary: false });
      setAgent('');
      const block = await buildHandoff('conv-1');
      expect(mockAsk).not.toHaveBeenCalled();
      expect(block).toContain('user: question 5');
    });

    it('chains: feeds the previous summary to the summarizer and keeps it if summarizing fails', async () => {
      const prior =
        '<previous_conversation>\n<summary>\nOld thread about the trip\n</summary>\n</previous_conversation>';
      mockMessages.mockResolvedValue([msg('user', `${prior}\n\nq1`), ...longConversation().slice(1)]);
      mockAsk.mockResolvedValueOnce({ conversationId: 't', outputText: 'new' });
      await buildHandoff('conv-2');
      expect(mockAsk.mock.calls[0][0].inputs[0].content).toContain('Old thread about the trip');

      mockAsk.mockRejectedValueOnce(new Error('boom'));
      const block = await buildHandoff('conv-2');
      expect(block).toContain('Old thread about the trip');
    });

    it('returns undefined when the conversation cannot be read', async () => {
      mockMessages.mockRejectedValue(new Error('404'));
      expect(await buildHandoff('conv-gone')).toBeUndefined();
    });
  });

  describe('waitFor', () => {
    it('returns the value, or undefined on timeout or rejection', async () => {
      expect(await waitFor(Promise.resolve(1), 50)).toBe(1);
      expect(await waitFor(new Promise<number>(() => undefined), 10)).toBeUndefined();
      expect(await waitFor(Promise.reject(new Error('x')), 50)).toBeUndefined();
    });
  });

  describe('nightly journal never sees the handoff', () => {
    it('stripHandoffBlock removes the block', () => {
      expect(stripHandoffBlock('<previous_conversation>\nx\n</previous_conversation>\n\nHi')).toBe('Hi');
    });

    it('buildTranscript drops the channel history block from group messages', () => {
      const transcript = buildTranscript([
        msg('user', '<channel_history>\nalice: OTHER PERSON SAID THIS\n</channel_history>\n\nHi'),
        msg('assistant', 'Hello')
      ] as never);
      expect(transcript).toBe('user: Hi\nassistant: Hello');
    });
    it('buildTranscript drops the block from replayed first messages', () => {
      const transcript = buildTranscript([
        msg('user', '<previous_conversation>\nSECRET SUMMARY\n</previous_conversation>\n\nHi'),
        msg('assistant', 'Hello')
      ] as never);
      expect(transcript).toBe('user: Hi\nassistant: Hello');
    });
  });
});
