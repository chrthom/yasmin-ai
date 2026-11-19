import { ChatAgent, mockFetch, setupChatAgent } from './fixtures/chat_agent.fixture';

describe('ChatAgent', () => {
  let chatAgent: ChatAgent;

  beforeEach(() => {
    chatAgent = setupChatAgent();
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
      // The GET list request retries network-style failures, so reject every attempt
      mockFetch.mockRejectedValue(new Error('Network error'));

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
});
