// Mock config for tests - MUST be before any imports that use config
jest.mock('../config', () => ({
  config: {
    server: { port: 5000 }
    mistral: {
      baseUrl: 'https://api.mistral.ai/v1/conversations'
      apiKey: 'test-api-key'
      agentId: 'test-agent-id'
      conversationTtlMs: 12 * 60 * 60 * 1000
    }
    synology: {
      chatIncomingUrl: 'https://thomsen.in/chat/webapi/entry.cgi'
      tokens: {
        bot: 'test-bot-token'
        slash: 'test-slash-token'
        group: 'test-group-token'
      }
    }
    rateLimit: { windowMs: 60 * 1000, max: 15 }
    validation: { maxTextLength: 10000, maxUsernameLength: 100 }
    chunk: { maxLength: 1800 }
  }
}));

import { Request, Response } from 'express';
import { createGroupController } from '../controllers/group.controller';
import { ChatAgent } from '../chat_agent';
import { SynologyClient } from '../synology_client';

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('Group Controller', () => {
  let chatAgent: ChatAgent;
  let synologyClient: SynologyClient;
  let groupController: (req: Request, res: Response) => Promise<void>;

  beforeEach(() => {
    chatAgent = new ChatAgent('https://test.url', 'test-api-key', 'test-agent-id');
    synologyClient = new SynologyClient('https://test.url', 'test-group-token');
    groupController = createGroupController(chatAgent, synologyClient);
    mockFetch.mockClear();
    jest.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should return 401 for invalid token', async () => {
      const req = {
        body: {
          text: 'Hello'
          token: 'wrong-token'
          user_id: 1
          username: 'testuser'
        }
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        sendStatus: jest.fn()
        status: jest.fn().mockReturnThis()
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await groupController(req, res);

      expect(res.sendStatus).toHaveBeenCalledWith(401);
    });

    it('should return 401 for missing token', async () => {
      const req = {
        body: {
          text: 'Hello'
          user_id: 1
          username: 'testuser'
        }
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        sendStatus: jest.fn()
        status: jest.fn().mockReturnThis()
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await groupController(req, res);

      expect(res.sendStatus).toHaveBeenCalledWith(401);
    });
  });

  describe('Request Validation', () => {
    it('should return 400 for invalid request body - missing text', async () => {
      const req = {
        body: {
          token: 'test-group-token'
          user_id: 1
          username: 'testuser'
        }
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis()
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await groupController(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.send).toHaveBeenCalledWith({ error: 'Invalid request body' });
    });

    it('should return 400 for invalid request body - missing user_id', async () => {
      const req = {
        body: {
          text: 'Hello'
          token: 'test-group-token'
          username: 'testuser'
        }
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis()
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await groupController(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.send).toHaveBeenCalledWith({ error: 'Invalid request body' });
    });

    it('should return 400 for invalid request body - missing username', async () => {
      const req = {
        body: {
          text: 'Hello'
          token: 'test-group-token'
          user_id: 1
        }
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis()
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await groupController(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.send).toHaveBeenCalledWith({ error: 'Invalid request body' });
    });

    it('should return 400 for empty text', async () => {
      const req = {
        body: {
          text: ''
          token: 'test-group-token'
          user_id: 1
          username: 'testuser'
        }
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis()
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await groupController(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 for invalid username format', async () => {
      const req = {
        body: {
          text: 'Hello'
          token: 'test-group-token'
          user_id: 1
          username: 'invalid username!'
        }
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis()
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await groupController(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('Successful Requests', () => {
    it('should return 200 with answer on success', async () => {
      // Mock conversation fetch (no active conversation)
      mockFetch.mockResolvedValueOnce({
        ok: true
        json: () => Promise.resolve([])
      });
      // Mock processRequest fetch (create new conversation with short answer)
      mockFetch.mockResolvedValueOnce({
        ok: true
        json: () => Promise.resolve({
          outputs: [{ content: 'Short answer', type: 'message.output' }]
        })
      });

      const req = {
        body: {
          text: 'Hello'
          token: 'test-group-token'
          user_id: 1
          username: 'testuser'
        }
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis()
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await groupController(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith({
        text: 'Short answer'
      });
    });

    it('should handle chunked responses correctly', async () => {
      // Mock conversation fetch
      mockFetch.mockResolvedValueOnce({
        ok: true
        json: () => Promise.resolve([])
      });
      // Mock processRequest fetch (create new conversation with short answer)
      mockFetch.mockResolvedValueOnce({
        ok: true
        json: () => Promise.resolve({
          outputs: [{ content: 'A'.repeat(2000), type: 'message.output' }]
        })
      });
      // Mock sendAnswersToChat fetch (will be called twice for chunked response)
      mockFetch.mockResolvedValueOnce({
        ok: true
        json: () => Promise.resolve({})
      });
      mockFetch.mockResolvedValueOnce({
        ok: true
        json: () => Promise.resolve({})
      });

      const req = {
        body: {
          text: 'Hello'
          token: 'test-group-token'
          user_id: 1
          username: 'testuser'
        }
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis()
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await groupController(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockFetch).toHaveBeenCalledTimes(4); // 1 for conversation, 1 for processRequest, 2 for chunked send
    });
  });

  describe('Error Handling', () => {
    it('should return 500 on ChatAgent error', async () => {
      // Mock conversation fetch to fail
      mockFetch.mockResolvedValueOnce({
        ok: false
        status: 500
        statusText: 'Internal Server Error'
        json: () => Promise.resolve({})
      });

      const req = {
        body: {
          text: 'Hello'
          token: 'test-group-token'
          user_id: 1
          username: 'testuser'
        }
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis()
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await groupController(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.send).toHaveBeenCalledWith({ error: 'Internal server error' });
    });

    it('should return 500 on SynologyClient error', async () => {
      // Mock conversation fetch
      mockFetch.mockResolvedValueOnce({
        ok: true
        json: () => Promise.resolve([])
      });
      // Mock processRequest fetch
      mockFetch.mockResolvedValueOnce({
        ok: true
        json: () => Promise.resolve({
          outputs: [{ content: 'Test response', type: 'message.output' }]
        })
      });
      // Mock sendAnswersToChat fetch to fail
      mockFetch.mockResolvedValueOnce({
        ok: false
        status: 500
        statusText: 'Internal Server Error'
        json: () => Promise.resolve({})
      });

      const req = {
        body: {
          text: 'Hello'
          token: 'test-group-token'
          user_id: 1
          username: 'testuser'
        }
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        sendStatus: jest.fn()
        status: jest.fn().mockReturnThis()
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await groupController(req, res);

      // Should still return 200 even if sending to Synology fails
      // (fire-and-forget pattern)
      expect(res.sendStatus).toHaveBeenCalledWith(200);
    });
  });
});
