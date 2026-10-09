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
      },
      history: {
        prevCount: 10,
        botUserId: 99,
        slashPrefix: '/yasmin',
        fetchTimeoutMs: 5000
      }
    },
    rateLimit: { windowMs: 60 * 1000, max: 15 },
    validation: { maxTextLength: 10000, maxUsernameLength: 100 },
    chunk: { maxLength: 1800 }
  }
}));

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

import { Request, Response } from 'express';
import { createChatController } from '../controllers/chat.controller';
import { ChatAgent } from '../chat_agent';
import { SynologyClient } from '../synology_client';

function createMockRequest(body: any, contentType = 'application/json'): Request {
  return {
    body,
    get: jest.fn().mockReturnValue(contentType)
  } as unknown as Request;
}

function createMockResponse() {
  const send = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnThis();
  const sendStatus = jest.fn().mockReturnThis();
  const json = jest.fn().mockReturnThis();

  return {
    res: {
      send,
      status,
      sendStatus,
      json
    } as unknown as Response,
    send,
    status,
    sendStatus,
    json
  };
}

function clearMocks() {
  mockFetch.mockClear();
  jest.clearAllMocks();
}

describe('Chat Controller', () => {
  let chatAgent: ChatAgent;
  let synologyClient: SynologyClient;

  beforeEach(() => {
    chatAgent = new ChatAgent('https://test.url', 'test-api-key', 'test-agent-id');
    synologyClient = new SynologyClient('https://test.url', 'test-token');
    clearMocks();
  });

  describe('Bot Controller (202 response)', () => {
    let controller: (req: Request, res: Response) => Promise<void>;

    beforeEach(() => {
      controller = createChatController(chatAgent, synologyClient, {
        token: 'test-bot-token',
        responseStatus: 202,
        sendToSynology: true
      });
    });

    it('should return 401 for invalid token', async () => {
      const req = createMockRequest(
        {
          text: 'Hello',
          token: 'wrong-token',
          user_id: 1,
          username: 'testuser'
        },
        'application/json'
      );
      const { res, sendStatus } = createMockResponse();

      await controller(req, res);

      expect(sendStatus).toHaveBeenCalledWith(401);
    });

    it('should return 400 for invalid request body', async () => {
      const req = createMockRequest(
        {
          token: 'test-bot-token',
          user_id: 1,
          username: 'testuser'
        },
        'application/json'
      );
      const { res, status, send } = createMockResponse();

      await controller(req, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(send).toHaveBeenCalledWith({ error: 'Invalid request body' });
    });

    it('should return 202 on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([])
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            outputs: [{ content: 'Test response', type: 'message.output' }]
          })
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({})
      });

      const req = createMockRequest(
        {
          text: 'Hello',
          token: 'test-bot-token',
          user_id: 1,
          username: 'testuser'
        },
        'application/json'
      );
      const { res, sendStatus } = createMockResponse();

      await controller(req, res);

      expect(sendStatus).toHaveBeenCalledWith(202);
    });
  });

  describe('Slash Controller (200 response with prefix stripping)', () => {
    let controller: (req: Request, res: Response) => Promise<void>;

    beforeEach(() => {
      controller = createChatController(chatAgent, synologyClient, {
        token: 'test-slash-token',
        responseStatus: 200,
        stripPrefix: '/yasmin',
        sendToSynology: true
      });
    });

    it('should return 401 for invalid token', async () => {
      const req = createMockRequest(
        {
          text: '/yasmin Hello',
          token: 'wrong-token',
          user_id: 1,
          username: 'testuser'
        },
        'application/json'
      );
      const { res, sendStatus } = createMockResponse();

      await controller(req, res);

      expect(sendStatus).toHaveBeenCalledWith(401);
    });

    it('should strip prefix from text', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([])
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            outputs: [{ content: 'Test response', type: 'message.output' }]
          })
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({})
      });

      const req = createMockRequest(
        {
          text: '/yasmin Hello',
          token: 'test-slash-token',
          user_id: 1,
          username: 'testuser'
        },
        'application/json'
      );
      const { res, status, send } = createMockResponse();

      await controller(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(send).toHaveBeenCalledWith({ text: 'Test response' });
    });
  });

  describe('Group Controller (200 response)', () => {
    let controller: (req: Request, res: Response) => Promise<void>;

    beforeEach(() => {
      controller = createChatController(chatAgent, synologyClient, {
        token: 'test-group-token',
        responseStatus: 200,
        sendToSynology: true
      });
    });

    it('should return 401 for invalid token', async () => {
      const req = createMockRequest(
        {
          text: 'Hello',
          token: 'wrong-token',
          user_id: 1,
          username: 'testuser'
        },
        'application/json'
      );
      const { res, sendStatus } = createMockResponse();

      await controller(req, res);

      expect(sendStatus).toHaveBeenCalledWith(401);
    });

    it('should return 200 with answer on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([])
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            outputs: [{ content: 'Group response', type: 'message.output' }]
          })
      });

      const req = createMockRequest(
        {
          text: 'Hello group',
          token: 'test-group-token',
          user_id: 1,
          username: 'testuser'
        },
        'application/json'
      );
      const { res, status, send } = createMockResponse();

      await controller(req, res);

      expect(status).toHaveBeenCalledWith(200);
      expect(send).toHaveBeenCalledWith({ text: 'Group response' });
    });
  });

  describe('Error Handling', () => {
    it('should return 500 on ChatAgent error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({})
      });

      const controller = createChatController(chatAgent, synologyClient, {
        token: 'test-bot-token',
        responseStatus: 202,
        sendToSynology: true
      });

      const req = createMockRequest(
        {
          text: 'Hello',
          token: 'test-bot-token',
          user_id: 1,
          username: 'testuser'
        },
        'application/json'
      );
      const { res, status, send } = createMockResponse();

      await controller(req, res);

      expect(status).toHaveBeenCalledWith(500);
      expect(send).toHaveBeenCalledWith({ error: 'Internal server error' });
    });
  });

  describe('Channel History', () => {
    const historyResponse = {
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            posts: [
              { post_id: 1, user_id: 10, username: 'alice', text: 'hello', timestamp: 100 },
              { post_id: 2, user_id: 99, username: 'yasmin', text: 'bot reply', timestamp: 200 }
            ]
          }
        })
    };
    const emptyConversationList = {
      ok: true,
      json: () => Promise.resolve([])
    };
    const conversationPost = (body: { inputs: { content: string }[] }) => ({
      ok: true,
      json: () => Promise.resolve({ outputs: [{ content: 'Test response', type: 'message.output' }] }),
      body: JSON.stringify(body)
    });

    it('prepends the channel history block for group requests with channel_id and post_id', async () => {
      mockFetch.mockResolvedValueOnce(historyResponse);
      mockFetch.mockImplementationOnce(() => Promise.resolve(emptyConversationList));
      mockFetch.mockImplementationOnce((url: string, init: { body: string }) =>
        Promise.resolve(conversationPost(JSON.parse(init.body)))
      );
      const controller = createChatController(chatAgent, synologyClient, {
        token: 'test-group-token',
        responseStatus: 200,
        sendToSynology: false,
        includeChannelHistory: true
      });
      const req = createMockRequest(
        {
          text: 'Hello',
          token: 'test-group-token',
          user_id: 1,
          username: 'testuser',
          channel_id: 5,
          post_id: 3
        },
        'application/json'
      );
      const { res, status } = createMockResponse();
      await controller(req, res);
      expect(status).toHaveBeenCalledWith(200);
      const prompt = JSON.parse([...mockFetch.mock.calls].reverse().find(c => c[1] && c[1].body)![1].body)
        .inputs[0].content;
      expect(prompt).toContain('<channel_history>');
      expect(prompt).toContain('alice: hello');
      expect(prompt).toContain('</channel_history>');
      expect(prompt).toContain('Answer the following message from testuser:\nHello');
      expect(prompt).not.toContain('yasmin');
    });

    it('does not fetch history for bot (direct chat) requests', async () => {
      mockFetch.mockImplementationOnce(() => Promise.resolve(emptyConversationList));
      mockFetch.mockImplementationOnce((url: string, init: { body: string }) =>
        Promise.resolve(conversationPost(JSON.parse(init.body)))
      );
      const controller = createChatController(chatAgent, synologyClient, {
        token: 'test-bot-token',
        responseStatus: 202,
        sendToSynology: false
      });
      const req = createMockRequest(
        {
          text: 'Hello',
          token: 'test-bot-token',
          user_id: 1,
          username: 'testuser',
          channel_id: 5,
          post_id: 3
        },
        'application/json'
      );
      const { res, sendStatus } = createMockResponse();
      await controller(req, res);
      expect(sendStatus).toHaveBeenCalledWith(202);
      const prompt = JSON.parse([...mockFetch.mock.calls].reverse().find(c => c[1] && c[1].body)![1].body)
        .inputs[0].content;
      expect(prompt.endsWith('\n\nHello')).toBe(true);
    });

    it('falls back to the plain prompt when the history fetch fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('HTTP 500'));
      mockFetch.mockImplementationOnce(() => Promise.resolve(emptyConversationList));
      mockFetch.mockImplementationOnce((url: string, init: { body: string }) =>
        Promise.resolve(conversationPost(JSON.parse(init.body)))
      );
      const controller = createChatController(chatAgent, synologyClient, {
        token: 'test-group-token',
        responseStatus: 200,
        sendToSynology: false,
        includeChannelHistory: true
      });
      const req = createMockRequest(
        {
          text: 'Hello',
          token: 'test-group-token',
          user_id: 1,
          username: 'testuser',
          channel_id: 5,
          post_id: 3
        },
        'application/json'
      );
      const { res, status } = createMockResponse();
      await controller(req, res);
      expect(status).toHaveBeenCalledWith(200);
      const prompt = JSON.parse([...mockFetch.mock.calls].reverse().find(c => c[1] && c[1].body)![1].body)
        .inputs[0].content;
      expect(prompt).toContain('\n\nHello\n\nYour answer must be shorter than 1500 characters.');
    });
  });
});
