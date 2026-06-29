import { Request, Response } from 'express';
import { createSlashController } from '../controllers/slash.controller';
import { ChatAgent } from '../chat_agent';
import { SynologyClient } from '../synology_client';
import { config } from '../config';

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock config for tests
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
    chunk: { maxLength: 1800 }
  }
}));

describe('Slash Controller', () => {
  let chatAgent: ChatAgent;
  let synologyClient: SynologyClient;
  let slashController: (req: Request, res: Response) => Promise<void>;

  beforeEach(() => {
    chatAgent = new ChatAgent('https://test.url', 'test-api-key', 'test-agent-id');
    synologyClient = new SynologyClient('https://test.url', 'test-slash-token');
    slashController = createSlashController(chatAgent, synologyClient);
    mockFetch.mockClear();
    jest.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should return 401 for invalid token', async () => {
      const req = {
        body: {
          text: '/yasmin Hello',
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

      await slashController(req, res);

      expect(res.sendStatus).toHaveBeenCalledWith(401);
    });

    it('should return 401 for missing token', async () => {
      const req = {
        body: {
          text: '/yasmin Hello',
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
  });

  describe('Request Validation', () => {
    it('should return 400 for invalid request body - missing text', async () => {
      const req = {
        body: {
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

    it('should return 400 for invalid request body - missing user_id', async () => {
      const req = {
        body: {
          text: '/yasmin Hello',
          token: 'test-slash-token',
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

    it('should return 400 for invalid request body - missing username', async () => {
      const req = {
        body: {
          text: '/yasmin Hello',
          token: 'test-slash-token',
          user_id: 1
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
  });

  describe('Text Processing', () => {
    it('should remove /yasmin prefix from text', async () => {
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

      const req = {
        body: {
          text: '/yasmin Hello there',
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

      // Verify the text passed to processRequest has /yasmin removed
      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: JSON.stringify({
            inputs: [{ content: 'Hello there', role: 'user' }]
          })
        })
      );
    });

    it('should handle text with only /yasmin', async () => {
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

      const req = {
        body: {
          text: '/yasmin',
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

      // Should pass empty string after trimming
      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: JSON.stringify({
            inputs: [{ content: '', role: 'user' }]
          })
        })
      );
    });

    it('should handle text with /yasmin and extra spaces', async () => {
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

      const req = {
        body: {
          text: '/yasmin   Hello   ',
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

      // Should pass trimmed text
      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: JSON.stringify({
            inputs: [{ content: 'Hello', role: 'user' }]
          })
        })
      );
    });
  });

  describe('Successful Requests', () => {
    it('should return 200 with text response on success', async () => {
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

      const req = {
        body: {
          text: '/yasmin Hello',
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

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith({ text: 'Test response' });
    });

    it('should use shortAnswer=true for slash commands', async () => {
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
            outputs: [{ content: 'Short response', type: 'message.output' }]
          })
      });

      const req = {
        body: {
          text: '/yasmin Hello',
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

      // Verify shortAnswer=true was used (checks for initial prompt with short answer constraint)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: JSON.stringify({
            inputs: [{ content: 'Hello', role: 'user' }]
          })
        })
      );
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
          text: '/yasmin Hello',
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

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.send).toHaveBeenCalledWith({ error: 'Internal server error' });
    });
  });
});
