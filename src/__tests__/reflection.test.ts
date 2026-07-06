// Mock config for tests -- MUST be before any imports that use config
jest.mock('../config', () => ({
  config: {
    mistral: {
      nightlyAgentId: 'nightly-agent-1'
    },
    nightly: {
      maxIterations: 15,
      eagerMaxChars: 2000
    }
  }
}));

jest.mock('../mistral/mistral_api', () => ({
  askAgent: jest.fn(),
  runAgentToolLoop: jest.fn()
}));

import { askAgent, runAgentToolLoop } from '../mistral/mistral_api';
import { truncateToCap } from '../nightly/privacy';
import {
  buildTranscript,
  runJournal,
  JOURNAL_SOFT_CAP_CHARS,
  runIntegrate,
  runReview,
  runCompact
} from '../nightly/reflection';

const mockAskAgent = askAgent as jest.Mock;
const mockRunAgentToolLoop = runAgentToolLoop as jest.Mock;

describe('reflection', () => {
  beforeEach(() => {
    mockAskAgent.mockReset();
    mockRunAgentToolLoop.mockReset();
  });

  describe('buildTranscript', () => {
    it('formats a simple exchange correctly when role is present', () => {
      const messages = [
        { type: 'message.input', role: 'user', content: 'hi there' },
        {
          type: 'message.output',
          role: 'assistant',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: 'world' }
          ]
        }
      ];

      const result = buildTranscript(messages);

      expect(result).toBe('user: hi there\nassistant: hello world');
    });

    it('infers roles from the type field when role is absent', () => {
      const messages = [
        { type: 'message.input', content: 'question' },
        { type: 'message.output', content: 'answer' }
      ];

      const result = buildTranscript(messages);

      expect(result).toBe('user: question\nassistant: answer');
    });

    it('skips messages whose extracted text is empty', () => {
      const messages = [
        { type: 'message.output', role: 'assistant', content: {} },
        { type: 'message.output', role: 'assistant', content: 'ok' }
      ];

      const result = buildTranscript(messages);

      expect(result).toBe('assistant: ok');
    });
  });

  describe('runJournal', () => {
    it('returns the first attempt text when it is under the soft cap', async () => {
      mockAskAgent.mockResolvedValueOnce({ outputText: '  short journal entry  ' });

      const result = await runJournal('Alice', 'transcript text');

      expect(result).toBe('short journal entry');
      expect(mockAskAgent).toHaveBeenCalledTimes(1);
      expect(mockAskAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'nightly-agent-1' }));
    });

    it('retries once and then truncates deterministically if still over cap', async () => {
      const tooLong = 'a'.repeat(JOURNAL_SOFT_CAP_CHARS + 500);
      mockAskAgent
        .mockResolvedValueOnce({ outputText: tooLong })
        .mockResolvedValueOnce({ outputText: tooLong });

      const result = await runJournal('Alice', 'transcript text');

      expect(mockAskAgent).toHaveBeenCalledTimes(2);
      expect(result).toBe(truncateToCap(tooLong, JOURNAL_SOFT_CAP_CHARS));
      expect(result.endsWith('…[truncated]')).toBe(true);
      expect(result.length).toBe(JOURNAL_SOFT_CAP_CHARS);
    });
  });

  describe('runIntegrate', () => {
    it('passes agentId/maxIterations through to runAgentToolLoop and returns its result', async () => {
      mockRunAgentToolLoop.mockResolvedValueOnce({
        conversationId: 'conv-1',
        finalText: 'staged 2 files',
        iterations: 3
      });

      const executeTool = jest.fn();
      const result = await runIntegrate(executeTool);

      expect(result).toEqual({ finalText: 'staged 2 files', iterations: 3 });
      expect(mockRunAgentToolLoop).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'nightly-agent-1', maxIterations: 15, executeTool })
      );
    });
  });

  describe('runReview', () => {
    const update = { path: 'people/alice.md', content: 'new content', isNew: false };

    it('parses a clean JSON verdict', async () => {
      mockAskAgent.mockResolvedValueOnce({ outputText: '{"approved": true, "reason": "looks good"}' });

      const result = await runReview(update, 'old content', []);

      expect(result).toEqual({ approved: true, reason: 'looks good' });
    });

    it('parses a verdict wrapped in a markdown code fence', async () => {
      mockAskAgent.mockResolvedValueOnce({
        outputText: '```json\n{"approved": false, "reason": "hallucinated"}\n```'
      });

      const result = await runReview(update, 'old content', []);

      expect(result).toEqual({ approved: false, reason: 'hallucinated' });
    });

    it('safely defaults to approved: false on unparseable output', async () => {
      mockAskAgent.mockResolvedValueOnce({ outputText: 'not json at all' });

      const result = await runReview(update, 'old content', []);

      expect(result.approved).toBe(false);
      expect(result.reason).toBe('Could not parse reviewer verdict; rejecting as a safe default.');
    });
  });

  describe('runCompact', () => {
    it('returns the first attempt when under cap', async () => {
      mockAskAgent.mockResolvedValueOnce({ outputText: '  short summary  ' });

      const result = await runCompact('family', undefined, 'stripped content');

      expect(result).toBe('short summary');
      expect(mockAskAgent).toHaveBeenCalledTimes(1);
    });

    it('retries once and then truncates deterministically if still over cap', async () => {
      const tooLong = 'b'.repeat(2500);
      mockAskAgent
        .mockResolvedValueOnce({ outputText: tooLong })
        .mockResolvedValueOnce({ outputText: tooLong });

      const result = await runCompact('person', 'Alice', 'stripped content');

      expect(mockAskAgent).toHaveBeenCalledTimes(2);
      expect(result).toBe(truncateToCap(tooLong, 2000));
      expect(result.endsWith('…[truncated]')).toBe(true);
    });
  });
});
