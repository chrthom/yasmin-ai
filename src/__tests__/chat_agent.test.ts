import { ChatAgent } from '../chat_agent';

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('ChatAgent', () => {
  let chatAgent: ChatAgent;

  beforeEach(() => {
    chatAgent = new ChatAgent('https://test.url', 'test-api-key', 'test-agent-id');
    mockFetch.mockClear();
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

      expect(promptContent).toContain('<context_entry title="Background on Christopher">');
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

    it('should handle null/undefined outputs', () => {
      const result = chatAgent.convertMultiPart([]);
      expect(result).toBe('');
    });
  });

  describe('processRequest', () => {
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
                  arguments: '{"title":"Background on Anjali"}'
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
      expect(secondBody.inputs[0].role).toBe('tool');
      expect(secondBody.inputs[0].tool_call_id).toBe('call-xyz');
      expect(JSON.parse(secondBody.inputs[0].content).title).toBe('Background on Anjali');
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
            arguments: '{"title":"Background on Anjali"}'
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
      expect(secondBody.inputs[0].role).toBe('tool');
      expect(secondBody.inputs[0].tool_call_id).toBe('call-flat-xyz');
      expect(JSON.parse(secondBody.inputs[0].content).title).toBe('Background on Anjali');
    });
  });
});
