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

  describe('buildInitialPrompt', () => {
    it('should build correct prompt for normal conversation', () => {
      // @ts-expect-error - accessing private method for testing
      const result = chatAgent.buildInitialPrompt('Hello there', 'christopher', false);
      expect(result).toContain('You are talking to Christopher');
      expect(result).toContain('who is 36 years old');
      expect(result).toContain('You are the daughter of Christopher');
      expect(result).toContain('Hello there');
    });

    it('should include short answer constraint when requested', () => {
      // @ts-expect-error - accessing private method for testing
      const result = chatAgent.buildInitialPrompt('Hello', 'anjali', true);
      expect(result).toContain('Your answer must be shorter than 1500 characters');
    });

    it('should handle unknown user', () => {
      // @ts-expect-error - accessing private method for testing
      const result = chatAgent.buildInitialPrompt('Hello', 'unknown', false);
      expect(result).toContain('who is 30 years old');
      expect(result).toContain('You are the distant relative of Unknown');
    });
  });

  describe('getActiveConversationId', () => {
    it('should return conversation ID for valid recent conversation', async () => {
      const mockResponse = [
        {
          name: 'testuser'
          id: 'conv-123'
          updated_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
          agent_id: 'test-agent-id'
        }
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true
        status: 200
        statusText: 'OK'
        json: () => Promise.resolve(mockResponse)
      });

      const result = await chatAgent['getActiveConversationId']('testuser');
      expect(result).toBe('conv-123');
    });

    it('should return undefined for old conversations', async () => {
      const mockResponse = [
        {
          name: 'testuser'
          id: 'conv-123'
          updated_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
          agent_id: 'test-agent-id'
        }
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true
        status: 200
        statusText: 'OK'
        json: () => Promise.resolve(mockResponse)
      });

      const result = await chatAgent['getActiveConversationId']('testuser');
      expect(result).toBeUndefined();
    });

    it('should return undefined for different agent conversations', async () => {
      const mockResponse = [
        {
          name: 'testuser'
          id: 'conv-123'
          updated_at: new Date().toISOString()
          agent_id: 'different-agent-id'
        }
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true
        status: 200
        statusText: 'OK'
        json: () => Promise.resolve(mockResponse)
      });

      const result = await chatAgent['getActiveConversationId']('testuser');
      expect(result).toBeUndefined();
    });

    it('should return most recent conversation', async () => {
      const mockResponse = [
        {
          name: 'testuser'
          id: 'conv-123'
          updated_at: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString()
          agent_id: 'test-agent-id'
        }
        {
          name: 'testuser'
          id: 'conv-456'
          updated_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()
          agent_id: 'test-agent-id'
        }
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true
        status: 200
        statusText: 'OK'
        json: () => Promise.resolve(mockResponse)
      });

      const result = await chatAgent['getActiveConversationId']('testuser');
      expect(result).toBe('conv-456');
    });
  });

  describe('convertMultiPart', () => {
    it('should handle string content', () => {
      const outputs = [
        {
          content: 'Simple text response'
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
            { type: 'text', text: 'Hello' }
            { type: 'image', text: '' }
            { type: 'text', text: 'world!' }
          ]
          type: 'message.output'
        }
      ];

      const result = chatAgent.convertMultiPart(outputs);
      expect(result).toBe('Hello world!');
    });

    it('should return empty string when no message.output found', () => {
      const outputs = [
        {
          content: 'Some content'
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
  });

  describe('processRequest', () => {
    it('should create new conversation when no active conversation exists', async () => {
      // Mock getActiveConversationId to return undefined
      jest.spyOn(chatAgent as any, 'getActiveConversationId').mockResolvedValueOnce(undefined);

      const mockResponse = {
        outputs: [
          {
            content: 'Test response'
            type: 'message.output'
          }
        ]
      };

      mockFetch.mockResolvedValueOnce({
        ok: true
        status: 200
        statusText: 'OK'
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
            content: 'Test response'
            type: 'message.output'
          }
        ]
      };

      mockFetch.mockResolvedValueOnce({
        ok: true
        status: 200
        statusText: 'OK'
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
            content: 'Short response'
            type: 'message.output'
          }
        ]
      };

      mockFetch.mockResolvedValueOnce({
        ok: true
        status: 200
        statusText: 'OK'
        json: () => Promise.resolve(mockResponse)
      });

      await chatAgent.processRequest('Hello', 'testuser', true);

      // Check that the request body contains the user text directly (not the full prompt)
      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.inputs[0].content).toBe('Hello');
    });
  });
});
