import { ChatAgent } from '../chat_agent';
import { buildHandoff } from '../handoff';

// The handoff talks to Mistral through its own client; it has dedicated tests in handoff.test.ts.
jest.mock('../handoff', () => ({
  ...jest.requireActual('../handoff'),
  buildHandoff: jest.fn()
}));
const mockBuildHandoff = buildHandoff as jest.Mock;

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('ChatAgent', () => {
  let chatAgent: ChatAgent;

  beforeEach(() => {
    chatAgent = new ChatAgent('https://test.url', 'test-api-key', 'test-agent-id');
    mockFetch.mockClear();
    mockBuildHandoff.mockReset();
    mockBuildHandoff.mockResolvedValue('<previous_conversation>\nHANDOFF\n</previous_conversation>');
  });

  describe('capitalize', () => {
    it('should capitalize the first letter', () => {
      // @ts-expect-error - accessing private method for testing
      const result = chatAgent.capitalize('hello');
      expect(result).toBe('Hello');
    });

    it('should handle empty string', () => {
      // @ts-expect-error - accessing private method for testing
      const result = chatAgent.capitalize('');
      expect(result).toBe('');
    });
  });

  describe('processRequest prompt builder', () => {
    it('should build correct prompt with prepended XML context for normal conversation', async () => {
      // Mock getActiveConversationId to return undefined (new conversation)
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue(undefined);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ outputs: [] })
      });

      await chatAgent.processRequest('Hello there', 'christopher', false);

      const fetchArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchArgs[1].body);
      const promptContent = body.inputs[0].content;

      expect(promptContent).toContain('<context_entry title="Profile of Christopher">');
      expect(promptContent).toContain("Christopher is Yasmin's father. His birthday was 03.12.1988.");
      expect(promptContent).toContain('Hello there');
    });

    it('should include short answer constraint when requested for new conversation', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue(undefined);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ outputs: [] })
      });

      await chatAgent.processRequest('Hello', 'anjali', true);

      const fetchArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchArgs[1].body);
      const promptContent = body.inputs[0].content;

      expect(promptContent).toContain('Your answer must be shorter than 1500 characters');
    });
  });

  describe('getActiveConversationId', () => {
    it('should return conversation ID for valid recent conversation', async () => {
      const mockResponse = [
        {
          name: 'testuser',
          id: 'conv-123',
          updated_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
          agent_id: 'test-agent-id'
        }
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(mockResponse)
      });

      const result = await chatAgent['getActiveConversationId']('testuser');
      expect(result).toBe('conv-123');
    });

    it('should return undefined for old conversations', async () => {
      const mockResponse = [
        {
          name: 'testuser',
          id: 'conv-123',
          updated_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          agent_id: 'test-agent-id'
        }
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(mockResponse)
      });

      const result = await chatAgent['getActiveConversationId']('testuser');
      expect(result).toBeUndefined();
    });

    it('should return undefined for different agent conversations', async () => {
      const mockResponse = [
        {
          name: 'testuser',
          id: 'conv-123',
          updated_at: new Date().toISOString(),
          agent_id: 'different-agent-id'
        }
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(mockResponse)
      });

      const result = await chatAgent['getActiveConversationId']('testuser');
      expect(result).toBeUndefined();
    });

    it('should return most recent conversation', async () => {
      const mockResponse = [
        {
          name: 'testuser',
          id: 'conv-123',
          updated_at: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
          agent_id: 'test-agent-id'
        },
        {
          name: 'testuser',
          id: 'conv-456',
          updated_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
          agent_id: 'test-agent-id'
        }
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(mockResponse)
      });

      const result = await chatAgent['getActiveConversationId']('testuser');
      expect(result).toBe('conv-456');
    });

    it('should skip conversations marked as poisoned', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => [
          {
            name: 'christopher',
            id: 'conv-broken',
            agent_id: 'test-agent-id',
            updated_at: new Date().toISOString()
          },
          {
            name: 'christopher',
            id: 'conv-healthy',
            agent_id: 'test-agent-id',
            updated_at: new Date(Date.now() - 1000).toISOString()
          }
        ]
      });
      (chatAgent as any).poisonedConversations.set('christopher', new Set(['conv-broken']));

      const result = await chatAgent['getActiveConversationId']('christopher');
      expect(result).toBe('conv-healthy');
    });

    it('should handle network errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(chatAgent['getActiveConversationId']('testuser')).rejects.toThrow('Network error');
    });

    it('should handle invalid JSON responses', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.reject(new SyntaxError('Invalid JSON'))
      });

      await expect(chatAgent['getActiveConversationId']('testuser')).rejects.toThrow();
    });
  });

  describe('convertMultiPart', () => {
    it('should handle string content', () => {
      const outputs = [
        {
          content: 'Simple text response',
          type: 'message.output'
        }
      ];

      const result = chatAgent.convertMultiPart(outputs);
      expect(result).toBe('Simple text response');
    });

    it('should handle multipart content', () => {
      const outputs = [
        {
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'image', text: '' },
            { type: 'text', text: 'world!' }
          ],
          type: 'message.output'
        }
      ];

      const result = chatAgent.convertMultiPart(outputs);
      expect(result).toBe('Hello world!');
    });

    it('should return empty string when no message.output found', () => {
      const outputs = [
        {
          content: 'Some content',
          type: 'other.type'
        }
      ];

      const result = chatAgent.convertMultiPart(outputs);
      expect(result).toBe('');
    });

    it('should return empty string when outputs is empty', () => {
      const result = chatAgent.convertMultiPart([]);
      expect(result).toBe('');
    });

    it('should skip thinking-only message.output and use later text message (web search flow)', () => {
      const outputs = [
        {
          content: [{ type: 'thinking', text: 'Let me search...' }],
          type: 'message.output'
        },
        {
          content: [
            { type: 'thinking', text: 'I found it.' },
            { type: 'text', text: '02.03.2027. Ziggo Dome, Amsterdam.' }
          ],
          type: 'message.output'
        }
      ];

      const result = chatAgent.convertMultiPart(<any>outputs);
      expect(result).toBe('02.03.2027. Ziggo Dome, Amsterdam.');
    });

    it('should join text parts across multiple message.output entries', () => {
      const outputs = [
        {
          content: [{ type: 'text', text: 'Hello' }],
          type: 'message.output'
        },
        {
          content: [{ type: 'text', text: 'world!' }],
          type: 'message.output'
        }
      ];

      const result = chatAgent.convertMultiPart(<any>outputs);
      expect(result).toBe('Hello world!');
    });

    it('should return empty string when all message.output entries are thinking-only', () => {
      const outputs = [
        {
          content: [{ type: 'thinking', text: 'Hmm...' }],
          type: 'message.output'
        }
      ];

      const result = chatAgent.convertMultiPart(<any>outputs);
      expect(result).toBe('');
    });

    it('should handle null/undefined outputs', () => {
      const result = chatAgent.convertMultiPart([]);
      expect(result).toBe('');
    });
  });

  describe('processRequest', () => {
    it('should start a fresh conversation once the turn limit is reached (compaction)', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue('conv-old');
      const mockResponse = {
        outputs: [{ content: 'Test response', type: 'message.output' }]
      };
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(mockResponse)
      });
      // Simulate an exhausted session: maxTurnsPerSession default is 50
      chatAgent['conversationCache'].set('testuser', {
        conversationId: 'conv-old',
        expiresAt: Date.now() + 60_000,
        loadedContextTitles: ['Profile of testuser'],
        turnCount: 50
      });
      const result = await chatAgent.processRequest('Hello', 'testuser');
      expect(result).toEqual(mockResponse.outputs);
      // Fresh conversation: POST goes to the base URL, not the old conversation URL
      expect(mockFetch.mock.calls[0][0]).toBe('https://test.url');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.agent_id).toBe('test-agent-id');
      expect(body.name).toBe('testuser');
      // Handoff block from the old conversation is prepended; stale loaded titles are reset
      expect(mockBuildHandoff).toHaveBeenCalledWith('conv-old');
      expect(body.inputs[0].content).toContain('<previous_conversation>\nHANDOFF');
      const cached = chatAgent['conversationCache'].get('testuser')!;
      expect(cached.turnCount).toBe(1);
      expect(cached.loadedContextTitles).not.toContain('Profile of testuser');
    });

    it('prepares the handoff in the background once the turn that exhausts the budget is answered', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue('conv-123');
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({ outputs: [{ content: 'ok', type: 'message.output' }] })
      });
      chatAgent['conversationCache'].set('testuser', {
        conversationId: 'conv-123',
        expiresAt: Date.now() + 60_000,
        loadedContextTitles: [],
        turnCount: 49
      });
      await chatAgent.processRequest('Hello', 'testuser');
      expect(mockBuildHandoff).toHaveBeenCalledTimes(1);
      expect(mockBuildHandoff).toHaveBeenCalledWith('conv-123');
      // The next turn starts a fresh conversation and reuses the precomputed handoff (no second build)
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue('conv-123');
      await chatAgent.processRequest('Next', 'testuser');
      expect(mockBuildHandoff).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.agent_id).toBe('test-agent-id');
      expect(body.inputs[0].content).toContain('HANDOFF');
    });

    it('falls back to the last turns only when the summary is not ready in time', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue('conv-old');
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({ outputs: [{ content: 'ok', type: 'message.output' }] })
      });
      const { config } = jest.requireActual('../config');
      const original = config.mistral.handoffWaitMs;
      config.mistral.handoffWaitMs = 20;
      mockBuildHandoff.mockImplementation((_id: string, opts?: { withSummary: boolean }) =>
        opts?.withSummary === false
          ? Promise.resolve('<previous_conversation>\nRECENT ONLY\n</previous_conversation>')
          : new Promise(() => undefined)
      );
      chatAgent['conversationCache'].set('testuser', {
        conversationId: 'conv-old',
        expiresAt: Date.now() + 60_000,
        loadedContextTitles: [],
        turnCount: 50
      });
      try {
        await chatAgent.processRequest('Hello', 'testuser');
      } finally {
        config.mistral.handoffWaitMs = original;
      }
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.inputs[0].content).toContain('RECENT ONLY');
    });

    it('should keep the existing conversation below the turn limit', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue('conv-123');
      const mockResponse = {
        outputs: [{ content: 'Test response', type: 'message.output' }]
      };
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(mockResponse)
      });
      chatAgent['conversationCache'].set('testuser', {
        conversationId: 'conv-123',
        expiresAt: Date.now() + 60_000,
        loadedContextTitles: [],
        turnCount: 0
      });
      await chatAgent.processRequest('Hello', 'testuser');
      expect(mockFetch.mock.calls[0][0]).toBe('https://test.url/conv-123');
      const cached = chatAgent['conversationCache'].get('testuser')!;
      expect(cached.turnCount).toBe(1);
    });

    it('should create new conversation when no active conversation exists', async () => {
      // Mock getActiveConversationId to return undefined
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValueOnce(undefined);

      const mockResponse = {
        outputs: [
          {
            content: 'Test response',
            type: 'message.output'
          }
        ]
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(mockResponse)
      });

      const result = await chatAgent.processRequest('Hello', 'testuser');
      expect(result).toEqual(mockResponse.outputs);

      // Should call the base URL without conversation ID
      expect(mockFetch).toHaveBeenCalledWith('https://test.url', expect.anything());
    });

    it('should use existing conversation when available', async () => {
      // Mock getActiveConversationId to return a conversation ID
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValueOnce('conv-123');

      const mockResponse = {
        outputs: [
          {
            content: 'Test response',
            type: 'message.output'
          }
        ]
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(mockResponse)
      });

      const result = await chatAgent.processRequest('Hello', 'testuser');
      expect(result).toEqual(mockResponse.outputs);

      // Should call the URL with conversation ID
      expect(mockFetch).toHaveBeenCalledWith('https://test.url/conv-123', expect.anything());
    });

    it('should use short answer prompt when requested', async () => {
      // Mock getActiveConversationId to return a conversation ID (existing conversation)
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValueOnce('conv-123');

      const mockResponse = {
        outputs: [
          {
            content: 'Short response',
            type: 'message.output'
          }
        ]
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(mockResponse)
      });

      await chatAgent.processRequest('Hello', 'testuser', true);

      // Check that the short answer constraint is appended regardless of conversation state
      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.inputs[0].content).toContain('Hello');
      expect(body.inputs[0].content).toContain('Your answer must be shorter than 1500 characters.');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(chatAgent.processRequest('Hello', 'testuser')).rejects.toThrow('Network error');
    });

    it('should process overlapping requests from the same user sequentially', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue('conv-123');

      const order: string[] = [];
      mockFetch.mockImplementation(async () => {
        order.push('start');
        await new Promise(resolve => setTimeout(resolve, 20));
        order.push('end');
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () =>
            Promise.resolve({
              outputs: [{ content: 'Test response', type: 'message.output' }]
            })
        };
      });

      const [first, second] = await Promise.all([
        chatAgent.processRequest('Hello', 'sameuser'),
        chatAgent.processRequest('World', 'sameuser')
      ]);

      expect(first).toEqual([{ content: 'Test response', type: 'message.output' }]);
      expect(second).toEqual([{ content: 'Test response', type: 'message.output' }]);
      expect(order).toEqual(['start', 'end', 'start', 'end']);
    });

    it('should keep processing later requests after a failed one', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue('conv-123');

      mockFetch.mockRejectedValueOnce(new Error('Network error')).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () =>
          Promise.resolve({
            outputs: [{ content: 'Recovered response', type: 'message.output' }]
          })
      });

      await expect(chatAgent.processRequest('Fail', 'testuser')).rejects.toThrow('Network error');
      const result = await chatAgent.processRequest('Recover', 'testuser');
      expect(result).toEqual([{ content: 'Recovered response', type: 'message.output' }]);
    });

    it('should handle API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({})
      });

      await expect(chatAgent.processRequest('Hello', 'testuser')).rejects.toThrow();
    });

    it('should handle tool call requests from Mistral API and send back tool outputs', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValueOnce('conv-123');

      const mockToolCallResponse = {
        id: 'conv-123',
        outputs: [
          {
            type: 'message.tool_calls',
            tool_calls: [
              {
                id: 'call-xyz',
                type: 'function',
                function: {
                  name: 'read_context_entry',
                  arguments: '{"title":"Profile of Anjali"}'
                }
              }
            ]
          }
        ]
      };

      const mockFinalResponse = {
        id: 'conv-123',
        outputs: [
          {
            content: 'Anjali is your mother and her birthday is 25.01.1989.',
            type: 'message.output'
          }
        ]
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(mockToolCallResponse)
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(mockFinalResponse)
      });

      const result = await chatAgent.processRequest('How is Anjali related?', 'christopher');
      expect(result).toEqual(mockFinalResponse.outputs);

      const firstCallArgs = mockFetch.mock.calls[0];
      const firstBody = JSON.parse(firstCallArgs[1].body);
      expect(firstBody.tools).toBeUndefined();

      const secondCallArgs = mockFetch.mock.calls[1];
      expect(secondCallArgs[0]).toBe('https://test.url/conv-123');
      const secondBody = JSON.parse(secondCallArgs[1].body);
      expect(secondBody.inputs[0].type).toBe('function.result');
      expect(secondBody.inputs[0].tool_call_id).toBe('call-xyz');
      expect(JSON.parse(secondBody.inputs[0].result).title).toBe('Profile of Anjali');
    });

    it('should handle flat function.call response structures from Mistral API and send back tool outputs', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValueOnce('conv-123');

      const mockToolCallResponse = {
        id: 'conv-123',
        outputs: [
          {
            object: 'entry',
            type: 'function.call',
            tool_call_id: 'call-flat-xyz',
            name: 'read_context_entry',
            arguments: '{"title":"Profile of Anjali"}'
          }
        ]
      };

      const mockFinalResponse = {
        id: 'conv-123',
        outputs: [
          {
            content: 'Anjali is your mother and her birthday is 25.01.1989.',
            type: 'message.output'
          }
        ]
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(mockToolCallResponse)
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(mockFinalResponse)
      });

      const result = await chatAgent.processRequest('How is Anjali related?', 'christopher');
      expect(result).toEqual(mockFinalResponse.outputs);

      const secondCallArgs = mockFetch.mock.calls[1];
      expect(secondCallArgs[0]).toBe('https://test.url/conv-123');
      const secondBody = JSON.parse(secondCallArgs[1].body);
      expect(secondBody.inputs[0].type).toBe('function.result');
      expect(secondBody.inputs[0].tool_call_id).toBe('call-flat-xyz');
      expect(JSON.parse(secondBody.inputs[0].result).title).toBe('Profile of Anjali');
    });

    it('read_context_entry returns a pointer, not the full text, for an entry already injected this conversation', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValueOnce(undefined);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () =>
          Promise.resolve({
            id: 'conv-456',
            outputs: [
              {
                type: 'message.tool_calls',
                tool_calls: [
                  {
                    id: 'call-dup',
                    type: 'function',
                    function: { name: 'read_context_entry', arguments: '{"title":"Profile of Christopher"}' }
                  }
                ]
              }
            ]
          })
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({ id: 'conv-456', outputs: [{ content: 'ok', type: 'message.output' }] })
      });

      // First turn of a new conversation: the sender's profile is injected as XML context up front.
      await chatAgent.processRequest('Hello', 'christopher');

      const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(firstBody.inputs[0].content).toContain('title="Profile of Christopher"');

      const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      const result = JSON.parse(secondBody.inputs[0].result);
      expect(result.already_in_context).toBe(true);
      expect(result.content).toBeUndefined();
    });

    it('read-only agent (post-cutover): answers a stray update_context_entry tool call with an error result instead of executing it', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValueOnce('conv-123');

      const mockToolCallResponse = {
        id: 'conv-123',
        outputs: [
          {
            type: 'message.tool_calls',
            tool_calls: [
              {
                id: 'call-write-1',
                type: 'function',
                function: {
                  name: 'update_context_entry',
                  arguments: '{"title":"Profile of Anjali","content":"malicious overwrite"}'
                }
              }
            ]
          }
        ]
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(mockToolCallResponse)
      });

      // Second fetch: the tool-result POST carrying the error result for the stray call.
      const mockAfterToolResponse = {
        id: 'conv-123',
        outputs: [{ type: 'message.output', content: 'I cannot update memory myself.' }]
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve(mockAfterToolResponse)
      });
      const result = await chatAgent.processRequest('Update Anjali profile', 'christopher');

      // The stray write tool call is answered with an error result (so the Mistral conversation
      // cannot stall on an unanswered tool_call_id), and no write ever reaches the DB layer.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const secondCallArgs = mockFetch.mock.calls[1];
      expect(secondCallArgs[0]).toBe('https://test.url/conv-123');
      const secondBody = JSON.parse(secondCallArgs[1].body);
      expect(secondBody.inputs).toHaveLength(1);
      expect(secondBody.inputs[0].type).toBe('function.result');
      expect(secondBody.inputs[0].tool_call_id).toBe('call-write-1');
      expect(JSON.parse(secondBody.inputs[0].result)).toEqual({
        success: false,
        error: 'Unsupported tool: update_context_entry'
      });
      expect(result).toEqual(mockAfterToolResponse.outputs);
    });

    it('respawns a fresh conversation when resuming a deleted conversation (HTTP 404)', async () => {
      // First call finds the cached conversation; after it is cleared the next call finds none
      // (simulating the conversation deleted by the nightly job), so a fresh one is spawned.
      jest
        .spyOn(chatAgent as any, 'getActiveConversationId')
        .mockResolvedValueOnce('conv-123')
        .mockResolvedValue(undefined);

      // Resume attempt -> 404 (the conversation no longer exists on Mistral)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      });

      // Fresh-conversation attempt -> success with a new conversation id
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          conversation_id: 'conv-fresh',
          outputs: [{ type: 'message.output', content: 'New conversation!' }]
        })
      });

      // Warm up cache first to simulate a cached hit
      (chatAgent as any).conversationCache.set('christopher', {
        conversationId: 'conv-123',
        expiresAt: Date.now() + 100000,
        loadedContextTitles: []
      });

      const result = await chatAgent.processRequest('Hello', 'christopher');

      // The message was answered instead of being dropped
      expect(result).toHaveLength(1);
      // The respawn request went to a fresh conversation, not the deleted one
      expect(mockFetch.mock.calls[0][0]).toContain('conv-123');
      expect(mockFetch.mock.calls[1][0]).not.toContain('conv-123');
      // The new conversation id is cached so the next turn resumes it
      expect((chatAgent as any).conversationCache.get('christopher').conversationId).toBe('conv-fresh');
    });

    it('does not re-select a poisoned conversation after a tool request fails', async () => {
      // First turn resumes an existing conversation whose answer contains a function call
      jest
        .spyOn(chatAgent as any, 'getActiveConversationId')
        .mockResolvedValueOnce('conv-poisoned')
        .mockResolvedValue(undefined);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          conversation_id: 'conv-poisoned',
          outputs: [
            {
              type: 'function.call',
              tool_call_id: 'call-1',
              name: 'read_context_entry',
              arguments: JSON.stringify({ title: 'Profile of Christopher' })
            }
          ]
        })
      });
      // Tool result submission fails with HTTP 500, poisoning the conversation
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      });
      // Respawn in a fresh conversation succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          conversation_id: 'conv-fresh',
          outputs: [{ type: 'message.output', content: 'Fresh answer' }]
        })
      });

      const result = await chatAgent.processRequest('Hello', 'christopher');

      expect(result).toHaveLength(1);
      // The tool result went to the poisoned conversation
      expect(mockFetch.mock.calls[1][0]).toContain('conv-poisoned');
      // The respawn went to a fresh conversation, not the poisoned one
      expect(mockFetch.mock.calls[2][0]).not.toContain('conv-poisoned');
      expect((chatAgent as any).conversationCache.get('christopher').conversationId).toBe('conv-fresh');
    });

    it('poisons the conversation on HTTP 400 so the respawn is not sent to the same broken conversation', async () => {
      jest
        .spyOn(chatAgent as any, 'getActiveConversationId')
        .mockResolvedValueOnce('conv-broken')
        .mockResolvedValue(undefined);

      // Resume attempt -> 400 (conversation left broken by a pending function call)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request'
      });
      // Fresh-conversation attempt -> success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          conversation_id: 'conv-fresh',
          outputs: [{ type: 'message.output', content: 'New conversation!' }]
        })
      });

      const result = await chatAgent.processRequest('Hello', 'christopher');

      expect(result).toHaveLength(1);
      expect(mockFetch.mock.calls[0][0]).toContain('conv-broken');
      expect(mockFetch.mock.calls[1][0]).not.toContain('conv-broken');
      const poisoned = (chatAgent as any).poisonedConversations.get('christopher');
      expect(poisoned.has('conv-broken')).toBe(true);
    });

    it('clears the cache and throws when a fresh conversation 404s (no respawn loop)', async () => {
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValue(undefined);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      });

      await expect(chatAgent.processRequest('Hello', 'christopher')).rejects.toThrow(
        'Mistral API request failed: HTTP 404'
      );
      // Only one request was made -- a fresh-conversation 404 must not trigger a respawn loop
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect((chatAgent as any).conversationCache.has('christopher')).toBe(false);
    });
  });
});
