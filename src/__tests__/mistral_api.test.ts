// Mock config for tests - MUST be before any imports that use config
jest.mock('../config', () => ({
  config: {
    mistral: {
      apiRoot: 'https://api.test/v1',
      apiKey: 'test-key',
      libraryId: 'lib-1',
      nightlyAgentId: 'nightly-agent-1'
    },
    nightly: {
      maxRetries: 3,
      maxIterations: 15
    }
  }
}));

import {
  MistralApiError,
  withRetry,
  listConversations,
  getConversationMessages,
  deleteConversation,
  askAgent,
  runAgentToolLoop,
  listDocuments,
  uploadDocument,
  deleteDocument,
  getTextContent,
  replaceDocument
} from '../mistral/mistral_api';

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('mistral_api', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  describe('withRetry', () => {
    it('succeeds after a sequence of 429, 429, then 200', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new MistralApiError('rate limited', 429))
        .mockRejectedValueOnce(new MistralApiError('rate limited', 429))
        .mockResolvedValueOnce('ok');

      const result = await withRetry(fn, { baseMs: 1 });

      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('fails fast on a plain 400 with no retry', async () => {
      const fn = jest.fn().mockRejectedValueOnce(new MistralApiError('bad request', 400));

      await expect(withRetry(fn, { baseMs: 1 })).rejects.toThrow(MistralApiError);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on plain network errors (not MistralApiError)', async () => {
      const fn = jest.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce('ok');

      const result = await withRetry(fn, { baseMs: 1 });

      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('stops retrying once retries are exhausted', async () => {
      const fn = jest.fn().mockRejectedValue(new MistralApiError('server error', 500));

      await expect(withRetry(fn, { baseMs: 1, retries: 2 })).rejects.toThrow(MistralApiError);
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('request timeout wiring', () => {
    it('passes an AbortSignal to fetch so a hung connection cannot block a phase forever', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] });

      await listConversations('2026-01-01T00:00:00Z');

      const [, init] = mockFetch.mock.calls[0];
      expect(init).toEqual(expect.objectContaining({ method: 'GET' }));
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal.aborted).toBe(false);
    });
  });

  describe('listConversations', () => {
    it('filters conversations by updatedAt and maps fields', async () => {
      const now = Date.now();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { id: 'c1', name: 'alice', agent_id: 'agent-1', updated_at: new Date(now).toISOString() },
          {
            id: 'c2',
            name: 'bob',
            agent_id: 'agent-1',
            updated_at: new Date(now - 100000).toISOString()
          }
        ]
      });

      const result = await listConversations(new Date(now - 1000).toISOString());

      expect(result).toEqual([
        { id: 'c1', name: 'alice', agentId: 'agent-1', updatedAt: expect.any(String) }
      ]);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test/v1/conversations',
        expect.objectContaining({ method: 'GET' })
      );
    });
  });

  describe('getConversationMessages', () => {
    it('maps snake_case fields to camelCase', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 'm1', type: 'message.output', role: 'assistant', content: 'hi' }]
      });

      const result = await getConversationMessages('conv-1');

      expect(result).toEqual([
        { id: 'm1', type: 'message.output', role: 'assistant', content: 'hi', createdAt: undefined }
      ]);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test/v1/conversations/conv-1/messages',
        expect.objectContaining({ method: 'GET' })
      );
    });
  });

  describe('deleteConversation', () => {
    it('does not throw on 404', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      await expect(deleteConversation('conv-1')).resolves.toBeUndefined();
    });

    it('succeeds on 204', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 204 });

      await expect(deleteConversation('conv-1')).resolves.toBeUndefined();
    });
  });

  describe('askAgent', () => {
    it('extracts outputText and toolCalls from the nested message.tool_calls shape', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'resp-1',
          conversation_id: 'conv-1',
          outputs: [
            {
              type: 'message.output',
              content: [
                { type: 'text', text: 'Hello' },
                { type: 'text', text: 'world' }
              ]
            },
            {
              type: 'message.tool_calls',
              tool_calls: [
                { id: 'tc-1', type: 'function', function: { name: 'do_thing', arguments: '{"a":1}' } }
              ]
            }
          ]
        })
      });

      const result = await askAgent({ agentId: 'agent-1', inputs: [{ role: 'user', content: 'hi' }] });

      expect(result.conversationId).toBe('conv-1');
      expect(result.outputText).toBe('Hello world');
      expect(result.toolCalls).toEqual([{ id: 'tc-1', name: 'do_thing', arguments: '{"a":1}' }]);
    });

    it('extracts toolCalls from the flat function.call shape', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'resp-2',
          conversation_id: 'conv-2',
          outputs: [
            { type: 'message.output', content: 'plain text' },
            { type: 'function.call', tool_call_id: 'tc-2', name: 'do_other', arguments: '{"b":2}' }
          ]
        })
      });

      const result = await askAgent({ agentId: 'agent-1', inputs: [{ role: 'user', content: 'hi' }] });

      expect(result.outputText).toBe('plain text');
      expect(result.toolCalls).toEqual([{ id: 'tc-2', name: 'do_other', arguments: '{"b":2}' }]);
    });

    it('posts to /conversations with agent_id/name when starting a new conversation', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'conv-3', outputs: [] })
      });

      await askAgent({ agentId: 'agent-1', name: 'christopher', inputs: [{ role: 'user', content: 'hi' }] });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test/v1/conversations');
      const body = JSON.parse(init.body);
      expect(body).toEqual({
        agent_id: 'agent-1',
        name: 'christopher',
        inputs: [{ role: 'user', content: 'hi' }]
      });
    });

    it('posts to /conversations/{id} with only inputs when continuing', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'conv-4', outputs: [] })
      });

      await askAgent({
        agentId: 'agent-1',
        conversationId: 'conv-4',
        inputs: [{ role: 'user', content: 'hi' }]
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test/v1/conversations/conv-4');
      const body = JSON.parse(init.body);
      expect(body).toEqual({ inputs: [{ role: 'user', content: 'hi' }] });
    });
  });

  describe('runAgentToolLoop', () => {
    it('executes a tool call, sends a function.result back, and stops when no more tool calls', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            id: 'conv-1',
            conversation_id: 'conv-1',
            outputs: [
              {
                type: 'message.tool_calls',
                tool_calls: [
                  { id: 'tc-1', type: 'function', function: { name: 'do_thing', arguments: '{"x":1}' } }
                ]
              }
            ]
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            id: 'conv-1',
            conversation_id: 'conv-1',
            outputs: [{ type: 'message.output', content: 'all done' }]
          })
        });

      const executeTool = jest.fn().mockResolvedValue('{"ok":true}');

      const result = await runAgentToolLoop({
        agentId: 'agent-1',
        initialInputs: [{ role: 'user', content: 'hi' }],
        maxIterations: 5,
        executeTool
      });

      expect(executeTool).toHaveBeenCalledWith('do_thing', { x: 1 });
      expect(result.finalText).toBe('all done');
      expect(result.iterations).toBe(1);

      // Second fetch call must send the tool result back
      const [, secondInit] = mockFetch.mock.calls[1];
      const secondBody = JSON.parse(secondInit.body);
      expect(secondBody.inputs).toEqual([
        { type: 'function.result', tool_call_id: 'tc-1', result: '{"ok":true}' }
      ]);
    });
  });

  describe('listDocuments', () => {
    it('assembles results across 2 pages', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: 'd1', name: 'Profile of Alice.md', process_status: 'done', summary: 'a summary' }],
            has_more: true
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: 'd2', name: 'Profile of Bob.md', process_status: 'done', summary: null }],
            has_more: false
          })
        });

      const result = await listDocuments();

      expect(result).toEqual([
        { id: 'd1', path: 'Profile of Alice.md', processStatus: 'done', summary: 'a summary' },
        { id: 'd2', path: 'Profile of Bob.md', processStatus: 'done', summary: null }
      ]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://api.test/v1/libraries/lib-1/documents?page=0&page_size=1000'
      );
      expect(mockFetch.mock.calls[1][0]).toBe(
        'https://api.test/v1/libraries/lib-1/documents?page=1&page_size=1000'
      );
    });

    it('stops at the hard page-count safety cap instead of looping forever on a server that always says has_more: true', async () => {
      let i = 0;
      mockFetch.mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 'd' + i++, name: 'Profile of X.md', process_status: 'done', summary: null }],
          has_more: true
        })
      }));

      const result = await listDocuments();

      // Each page contributes a new doc, so no-progress never trips; the page cap (100) bounds it.
      expect(mockFetch.mock.calls.length).toBe(100);
      expect(result).toHaveLength(100);
    });

    it('stops pagination early when the server returns no new documents (ignores "page=")', async () => {
      const page = {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: 'd1', name: 'Profile of Alice.md', process_status: 'done', summary: null },
            { id: 'd2', name: 'Profile of Bob.md', process_status: 'done', summary: null }
          ],
          has_more: true
        })
      };
      mockFetch.mockResolvedValue(page);

      const result = await listDocuments();

      // Page 1 collects both docs; page 2 is all duplicates -> stop, don't build 100x copies.
      expect(mockFetch.mock.calls.length).toBe(2);
      expect(result).toEqual([
        { id: 'd1', path: 'Profile of Alice.md', processStatus: 'done', summary: null },
        { id: 'd2', path: 'Profile of Bob.md', processStatus: 'done', summary: null }
      ]);
    });
  });

  describe('uploadDocument', () => {
    it('sends a multipart/form-data POST without a manual Content-Type header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          id: 'd1',
          name: 'Profile of Alice.md',
          process_status: 'pending',
          summary: null
        })
      });

      const result = await uploadDocument('Profile of Alice.md', '# Alice');

      expect(result).toEqual({
        id: 'd1',
        path: 'Profile of Alice.md',
        processStatus: 'pending',
        summary: null
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test/v1/libraries/lib-1/documents');
      expect(init.headers).toEqual({ Authorization: 'Bearer test-key' });
      expect(init.body).toBeInstanceOf(FormData);
    });
  });

  describe('deleteDocument', () => {
    it('does not throw on 404', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      await expect(deleteDocument('doc-1')).resolves.toBeUndefined();
    });
  });

  describe('getTextContent', () => {
    it('returns raw text (not JSON) from the response body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => 'raw markdown content'
      });

      const result = await getTextContent('doc-1');

      expect(result).toBe('raw markdown content');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test/v1/libraries/lib-1/documents/doc-1/text_content',
        expect.objectContaining({ method: 'GET' })
      );
    });
  });

  describe('replaceDocument', () => {
    it('calls delete then upload, in that order', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 204 }) // delete
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({
            id: 'd2',
            name: 'Profile of Alice.md',
            process_status: 'pending',
            summary: null
          })
        }); // upload

      const result = await replaceDocument('Profile of Alice.md', '# Alice v2', 'old-doc-id');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.test/v1/libraries/lib-1/documents/old-doc-id');
      expect(mockFetch.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'DELETE' }));
      expect(mockFetch.mock.calls[1][0]).toBe('https://api.test/v1/libraries/lib-1/documents');
      expect(mockFetch.mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'POST' }));
      expect(result.id).toBe('d2');
    });

    it('ignores a 404 from the delete step and still uploads', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 404 }) // delete (already gone)
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({
            id: 'd3',
            name: 'Profile of Bob.md',
            process_status: 'pending',
            summary: null
          })
        }); // upload

      const result = await replaceDocument('Profile of Bob.md', '# Bob', 'gone-doc-id');

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.id).toBe('d3');
    });
  });
});
