import { Request, Response } from 'express';
import { createBotController } from '../controllers/bot.controller';
import { ChatAgent } from '../chat_agent';
import { SynologyClient } from '../synology_client';
import { config } from '../config';

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('Bot Controller', () => {
  let chatAgent: ChatAgent;
  let synologyClient: SynologyClient;
  let botController: (req: Request, res: Response) => Promise<void>;

  beforeEach(() => {
    chatAgent = new ChatAgent('https://test.url', 'test-api-key', 'test-agent-id');
    synologyClient = new SynologyClient('https://test.url', 'test-bot-token');
    botController = createBotController(chatAgent, synologyClient);
    mockFetch.mockClear();
    jest.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should return 401 for invalid token', async () => {
      const req = {
        body: {
          text: 'Hello',
          token: 'wrong-token',
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

    it('should return 401 for missing token', async () => {
      const req = {
        body: {
          text: 'Hello',
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
  });

  describe('Request Validation', () => {
    it('should return 400 for invalid request body - missing text', async () => {
      const req = {
        body: {
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

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.send).toHaveBeenCalledWith({ error: 'Invalid request body' });
    });

    it('should return 400 for invalid request body - missing user_id', async () => {
      const req = {
        body: {
          text: 'Hello',
          token: config.synology.tokens.bot,
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

    it('should return 400 for invalid request body - missing username', async () => {
      const req = {
        body: {
          text: 'Hello',
          token: config.synology.tokens.bot,
          user_id: 1
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

    it('should return 400 for empty text', async () => {
      const req = {
        body: {
          text: '',
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

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 for invalid username format', async () => {
      const req = {
        body: {
          text: 'Hello',
          token: config.synology.tokens.bot,
          user_id: 1,
          username: 'invalid username!'
        },
        get: jest.fn().mockReturnValue('application/json')
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis()
      } as unknown as Response;

      await botController(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('Successful Requests', () => {
    it('should return 202 and send answer to Synology on success', async () => {
      // Mock conversation fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([])
      });
      // Mock processRequest fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          outputs: [{ content: 'Test response', type: 'message.output' }]
        })
      });
      // Mock sendAnswersToChat fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({})
      });

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

      expect(res.sendStatus).toHaveBeenCalledWith(202);
    });

    it('should handle chunked responses correctly', async () => {
      // Mock conversation fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([])
      });
      // Mock processRequest fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
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

      expect(res.sendStatus).toHaveBeenCalledWith(202);
      expect(mockFetch).toHaveBeenCalledTimes(4); // 1 for conversation, 1 for processRequest, 2 for chunked send
    });
  });

  describe('Error Handling', () => {
    it('should return 500 on ChatAgent error', async () => {
      // Mock conversation fetch to fail
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({})
      });

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

    it('should return 500 on SynologyClient error', async () => {
      // Mock conversation fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([])
      });
      // Mock processRequest fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
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
      // (fire-and-forget pattern)
      expect(res.sendStatus).toHaveBeenCalledWith(202);
    });
  });
});
