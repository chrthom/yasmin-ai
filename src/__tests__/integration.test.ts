import { Request, Response } from 'express';
import { createBotController } from '../controllers/bot.controller';
import { createSlashController } from '../controllers/slash.controller';
import { createGroupController } from '../controllers/group.controller';
import { ChatAgent } from '../chat_agent';
import { SynologyClient } from '../synology_client';
import { config } from '../config';

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('Integration Tests', () => {
  let chatAgent: ChatAgent;
  let synologyClient: SynologyClient;

  beforeEach(() => {
    chatAgent = new ChatAgent('https://test.url', 'test-api-key', 'test-agent-id');
    synologyClient = new SynologyClient('https://test.url', 'test-token');
    mockFetch.mockClear();
    jest.clearAllMocks();
  });

  describe('Full Flow Tests', () => {
    it('should handle bot chat full flow: request -> ChatAgent -> SynologyClient', async () => {
      // Mock conversation fetch (no active conversation)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([])
      });
      // Mock processRequest fetch (create new conversation)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            outputs: [{ content: 'Hello from Yasmin!', type: 'message.output' }]
          })
      });
      // Mock sendAnswersToChat fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({})
      });

      const botController = createBotController(chatAgent, synologyClient);
      const req = {
        body: {
          text: 'Hello',
          token: config.synology.tokens.bot,
          user_id: 1,
          username: 'testuser'
        },
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        sendStatus: jest.fn(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await botController(req, res);

      // Verify the flow:
      // 1. getActiveConversationId was called (first fetch)
      expect(mockFetch).toHaveBeenNthCalledWith(1, 'https://test.url', expect.anything());

      // 2. processRequest was called (second fetch - POST to create conversation)
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'https://test.url',
        expect.objectContaining({
          method: 'post',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-api-key'
          })
        })
      );

      // 3. sendAnswersToChat was called (third fetch)
      expect(mockFetch).toHaveBeenNthCalledWith(3, expect.stringContaining('test-token'), expect.anything());

      // 4. Response was 202
      expect(res.sendStatus).toHaveBeenCalledWith(202);
    });

    it('should handle slash command full flow with text processing', async () => {
      // Mock conversation fetch (no active conversation)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([])
      });
      // Mock processRequest fetch (create new conversation with short answer)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            outputs: [{ content: 'Short answer', type: 'message.output' }]
          })
      });

      const slashController = createSlashController(chatAgent, synologyClient);
      const req = {
        body: {
          text: '/yasmin What is the weather?',
          token: config.synology.tokens.slash,
          user_id: 1,
          username: 'testuser'
        },
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await slashController(req, res);

      // Verify the text was processed (slash command removed)
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({
          body: JSON.stringify({
            inputs: [{ content: 'What is the weather?', role: 'user' }]
          })
        })
      );

      // Verify response was 200 with text
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith({ text: 'Short answer' });
    });

    it('should handle group chat full flow with short answer', async () => {
      // Mock conversation fetch (no active conversation)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([])
      });
      // Mock processRequest fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            outputs: [{ content: 'Group response', type: 'message.output' }]
          })
      });

      const groupController = createGroupController(chatAgent, synologyClient);
      const req = {
        body: {
          text: 'Hello group!',
          token: config.synology.tokens.group,
          user_id: 1,
          username: 'testuser'
        },
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await groupController(req, res);

      // Verify response was 200 with text
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith({ text: 'Group response' });
    });

    it('should handle existing conversation flow', async () => {
      // Mock conversation fetch (existing conversation)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              name: 'testuser',
              id: 'conv-123',
              updated_at: new Date().toISOString(),
              agent_id: 'test-agent-id'
            }
          ])
      });
      // Mock processRequest fetch (use existing conversation)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            outputs: [{ content: 'Using existing conversation', type: 'message.output' }]
          })
      });
      // Mock sendAnswersToChat fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({})
      });

      const botController = createBotController(chatAgent, synologyClient);
      const req = {
        body: {
          text: 'Continue conversation',
          token: config.synology.tokens.bot,
          user_id: 1,
          username: 'testuser'
        },
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        sendStatus: jest.fn(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await botController(req, res);

      // Verify existing conversation was used (PUT to conversation endpoint)
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'https://test.url/conv-123', expect.anything());

      // Verify response was 202
      expect(res.sendStatus).toHaveBeenCalledWith(202);
    });

    it('should handle chunked responses for long answers', async () => {
      // Mock conversation fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([])
      });
      // Mock processRequest fetch with long response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            outputs: [{ content: 'A'.repeat(2000), type: 'message.output' }]
          })
      });
      // Mock sendAnswersToChat fetch (will be called twice for chunked response)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({})
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({})
      });

      const botController = createBotController(chatAgent, synologyClient);
      const req = {
        body: {
          text: 'Tell me a long story',
          token: config.synology.tokens.bot,
          user_id: 1,
          username: 'testuser'
        },
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        sendStatus: jest.fn(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await botController(req, res);

      // Verify sendAnswersToChat was called twice (for chunked response)
      expect(mockFetch).toHaveBeenCalledTimes(4); // 1 conversation, 1 processRequest, 2 send
      expect(res.sendStatus).toHaveBeenCalledWith(202);
    });
  });

  describe('Error Flow Tests', () => {
    it('should handle Mistral API 429 rate limit error', async () => {
      // Mock conversation fetch to return 429
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: () => Promise.resolve({})
      });

      const botController = createBotController(chatAgent, synologyClient);
      const req = {
        body: {
          text: 'Hello',
          token: config.synology.tokens.bot,
          user_id: 1,
          username: 'testuser'
        },
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await botController(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.send).toHaveBeenCalledWith({ error: 'Internal server error' });
    });

    it('should handle Mistral API 401 unauthorized error', async () => {
      // Mock conversation fetch to return 401
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: () => Promise.resolve({})
      });

      const slashController = createSlashController(chatAgent, synologyClient);
      const req = {
        body: {
          text: '/yasmin Hello',
          token: config.synology.tokens.slash,
          user_id: 1,
          username: 'testuser'
        },
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await slashController(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.send).toHaveBeenCalledWith({ error: 'Internal server error' });
    });

    it('should handle Synology API error when sending response', async () => {
      // Mock conversation fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([])
      });
      // Mock processRequest fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            outputs: [{ content: 'Test response', type: 'message.output' }]
          })
      });
      // Mock sendAnswersToChat fetch to fail
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({})
      });

      const botController = createBotController(chatAgent, synologyClient);
      const req = {
        body: {
          text: 'Hello',
          token: config.synology.tokens.bot,
          user_id: 1,
          username: 'testuser'
        },
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        sendStatus: jest.fn(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await botController(req, res);

      // Should still return 202 even if sending to Synology fails
      // (fire-and-forget pattern - we accepted the request)
      expect(res.sendStatus).toHaveBeenCalledWith(202);
    });
  });
});
