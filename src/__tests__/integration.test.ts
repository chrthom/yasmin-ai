// Mock config for tests - MUST be before any imports that use config
jest.mock('../config', () => ({
  config: {
    server: { port: 5000 },
    mistral: {
      baseUrl: 'https://api.mistral.ai/v1/conversations',
      apiKey: 'test-api-key',
      agentId: 'test-agent-id',
      conversationTtlMs: 12 * 60 * 60 * 1000
    },
    synology: {
      chatIncomingUrl: 'https://thomsen.in/chat/webapi/entry.cgi',
      tokens: {
        bot: 'test-bot-token',
        slash: 'test-slash-token',
        group: 'test-group-token'
      }
    },
    rateLimit: { windowMs: 60 * 1000, max: 15 },
    validation: { maxTextLength: 10000, maxUsernameLength: 100 },
    chunk: { maxLength: 1800 },
    // Retries are disabled so withRetry's exponential backoff does not slow the suite;
    // the retry behavior itself is covered by the mistral_api tests.
    nightly: { maxRetries: 0 }
  }
}));

import { Request, Response } from 'express';
import {
  createBotController,
  createSlashController,
  createGroupController
} from '../controllers/chat.controller';
import { ChatAgent } from '../chat_agent';
import { SynologyClient } from '../synology_client';

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
          token: 'test-bot-token',
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
          method: 'post'
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
          token: 'test-slash-token',
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

      // Verify the flow:
      // 1. getActiveConversationId was called (first fetch)
      expect(mockFetch).toHaveBeenNthCalledWith(1, 'https://test.url', expect.anything());

      // 2. processRequest was called (second fetch - POST to create conversation)
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'https://test.url',
        expect.objectContaining({
          method: 'post'
        })
      );

      // 3. Response was 200 with answer
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith({
        text: 'Short answer'
      });
    });

    it('should handle group chat full flow with short answer', async () => {
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
            outputs: [{ content: 'Group response', type: 'message.output' }]
          })
      });

      const groupController = createGroupController(chatAgent, synologyClient);
      const req = {
        body: {
          text: 'Hello group!',
          token: 'test-group-token',
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

      // Verify the flow:
      // 1. getActiveConversationId was called (first fetch)
      expect(mockFetch).toHaveBeenNthCalledWith(1, 'https://test.url', expect.anything());

      // 2. processRequest was called (second fetch - POST to create conversation)
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'https://test.url',
        expect.objectContaining({
          method: 'post'
        })
      );

      // 3. Response was 200 with answer
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith({
        text: 'Group response'
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle validation errors in bot chat', async () => {
      const botController = createBotController(chatAgent, synologyClient);
      const req = {
        body: {
          text: '',
          token: 'test-bot-token',
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

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.send).toHaveBeenCalledWith({ error: 'Invalid request body' });
    });

    it('should handle validation errors in slash command', async () => {
      const slashController = createSlashController(chatAgent, synologyClient);
      const req = {
        body: {
          text: '',
          token: 'test-slash-token',
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

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.send).toHaveBeenCalledWith({ error: 'Invalid request body' });
    });

    it('should handle validation errors in group chat', async () => {
      const groupController = createGroupController(chatAgent, synologyClient);
      const req = {
        body: {
          text: '',
          token: 'test-group-token',
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

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.send).toHaveBeenCalledWith({ error: 'Invalid request body' });
    });
  });

  describe('Authentication', () => {
    it('should reject bot chat with invalid token', async () => {
      const botController = createBotController(chatAgent, synologyClient);
      const req = {
        body: {
          text: 'Hello',
          token: 'invalid-token',
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

      expect(res.sendStatus).toHaveBeenCalledWith(401);
    });

    it('should reject slash command with invalid token', async () => {
      const slashController = createSlashController(chatAgent, synologyClient);
      const req = {
        body: {
          text: '/yasmin Hello',
          token: 'invalid-token',
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

      await slashController(req, res);

      expect(res.sendStatus).toHaveBeenCalledWith(401);
    });

    it('should reject group chat with invalid token', async () => {
      const groupController = createGroupController(chatAgent, synologyClient);
      const req = {
        body: {
          text: 'Hello',
          token: 'invalid-token',
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

      await groupController(req, res);

      expect(res.sendStatus).toHaveBeenCalledWith(401);
    });
  });
});
