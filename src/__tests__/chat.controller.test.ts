// ChatAgent builds its conversation URLs from the shared Mistral client helper; pin it to a
// fixed value so fetch assertions stay deterministic regardless of config.
jest.mock('../mistral/mistral_api', () => ({
  ...jest.requireActual('../mistral/mistral_api'),
  conversationsUrl: () => 'https://test.url'
}));

// Mock config for tests - MUST be before any imports that use config
jest.mock('../config', () => ({
  config: {
    server: { port: 5000 },
    mistral: {
      apiKey: 'test-api-key',
      agentId: 'test-agent-id',
      conversationTtlMs: 12 * 60 * 60 * 1000,
      requestTimeoutMs: 30_000,
      maxToolCalls: 5
    },
    context: {
      familyNotesTitle: 'Family notes',
      profileOfYasminTitle: 'Profile of Yasmin'
    },
    chat: {
      noteContentMaxChars: 500,
      noteToEveryone: 'everyone',
      shortAnswerMaxChars: 1500
    },
    handoff: {
      recentMessageMaxChars: 600,
      summaryMaxChars: 2500,
      summarizerInputMaxChars: 30000,
      summarizerTurnMaxChars: 1500
    },
    nightly: {
      hour: 23,
      minute: 0,
      transcriptMaxChars: 20000,
      journalSoftCapChars: 4000,
      shutdownTimeoutMs: 30_000,
      maxRetries: 0
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

// The context model talks to MariaDB; serve the shared test fixture instead (see context.test.ts).
jest.mock('../database/models/context.model', () => {
  const { TEST_CONTEXT_DATA } = jest.requireActual('./fixtures/context_data');
  return {
    getAllEntriesFromDb: jest.fn(async () => TEST_CONTEXT_DATA),
    getAllTitlesFromDb: jest.fn(async () =>
      TEST_CONTEXT_DATA.map((record: { title: string }) => record.title)
    ),
    getContentByTitleFromDb: jest.fn(
      async (title: string) =>
        TEST_CONTEXT_DATA.find(
          (record: { title: string; content: string }) => record.title.toLowerCase() === title.toLowerCase()
        )?.content ?? null
    ),
    isKnownPerson: jest.fn(async () => true)
  };
});

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
    chatAgent = new ChatAgent('test-api-key', 'test-agent-id');
    synologyClient = new SynologyClient('https://test.url', 'test-token');
    clearMocks();
  });

  describe('Bot Controller (202 response)', () => {
    let controller: (req: Request, res: Response) => Promise<void>;

    beforeEach(() => {
      controller = createChatController(chatAgent, synologyClient, {
        token: 'test-bot-token',
        responseStatus: 202,
        shortAnswer: false,
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
        shortAnswer: true,
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
        shortAnswer: true,
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
        shortAnswer: false,
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
    const lastPrompt = () => {
      const call = [...mockFetch.mock.calls].reverse().find(c => c[1] && c[1].body)!;
      return JSON.parse(call[1].body).inputs[0].content;
    };
    const postListPayload = () => {
      const call = mockFetch.mock.calls.find(c => String(c[0]).includes('post_list'))!;
      return JSON.parse(call[1].body.get('payload'));
    };

    it('prepends the channel history block for group requests with channel_id and post_id', async () => {
      mockFetch.mockResolvedValueOnce(historyResponse);
      mockFetch.mockImplementationOnce(() => Promise.resolve(emptyConversationList));
      mockFetch.mockImplementationOnce((url: string, init: { body: string }) =>
        Promise.resolve(conversationPost(JSON.parse(init.body)))
      );
      const controller = createChatController(chatAgent, synologyClient, {
        token: 'test-group-token',
        responseStatus: 200,
        shortAnswer: true,
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
      expect(postListPayload().token).toBe('test-group-token');
      const prompt = lastPrompt();
      expect(prompt).toContain('<channel_history>');
      expect(prompt).toContain('alice: hello');
      expect(prompt).toContain('</channel_history>');
      expect(prompt).toContain(
        '</channel_history>\n\nHello\n\nYour answer must be shorter than 1500 characters.'
      );
      expect(prompt).not.toContain('yasmin');
    });

    it('fetches history with the slash token for slash commands and filters slash-command posts', async () => {
      const slashHistoryResponse = {
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: {
              posts: [
                { post_id: 1, user_id: 10, username: 'alice', text: 'hello', timestamp: 100 },
                { post_id: 2, user_id: 12, username: 'carol', text: '/yasmin do this', timestamp: 150 }
              ]
            }
          })
      };
      mockFetch.mockResolvedValueOnce(slashHistoryResponse);
      mockFetch.mockImplementationOnce(() => Promise.resolve(emptyConversationList));
      mockFetch.mockImplementationOnce((url: string, init: { body: string }) =>
        Promise.resolve(conversationPost(JSON.parse(init.body)))
      );
      const controller = createChatController(chatAgent, synologyClient, {
        token: 'test-slash-token',
        responseStatus: 200,
        shortAnswer: true,
        stripPrefix: '/yasmin',
        sendToSynology: false,
        includeChannelHistory: true
      });
      const req = createMockRequest(
        {
          text: '/yasmin Hello',
          token: 'test-slash-token',
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
      expect(postListPayload().token).toBe('test-slash-token');
      const prompt = lastPrompt();
      expect(prompt).toContain('<channel_history>');
      expect(prompt).toContain('alice: hello');
      expect(prompt).not.toContain('/yasmin do this');
      expect(prompt).toContain(
        '</channel_history>\n\nHello\n\nYour answer must be shorter than 1500 characters.'
      );
    });

    it('does not fetch history for bot (direct chat) requests', async () => {
      mockFetch.mockImplementationOnce(() => Promise.resolve(emptyConversationList));
      mockFetch.mockImplementationOnce((url: string, init: { body: string }) =>
        Promise.resolve(conversationPost(JSON.parse(init.body)))
      );
      const controller = createChatController(chatAgent, synologyClient, {
        token: 'test-bot-token',
        responseStatus: 202,
        shortAnswer: false,
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
      const prompt = lastPrompt();
      expect(prompt.endsWith('\n\nHello')).toBe(true);
    });

    it('falls back to the plain prompt when the history fetch fails', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      mockFetch.mockRejectedValueOnce(new Error('HTTP 500'));
      mockFetch.mockImplementationOnce(() => Promise.resolve(emptyConversationList));
      mockFetch.mockImplementationOnce((url: string, init: { body: string }) =>
        Promise.resolve(conversationPost(JSON.parse(init.body)))
      );
      const controller = createChatController(chatAgent, synologyClient, {
        token: 'test-group-token',
        responseStatus: 200,
        shortAnswer: true,
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
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch channel history; continuing without it')
      );
      warn.mockRestore();
      const prompt = lastPrompt();
      expect(prompt).toContain('\n\nHello\n\nYour answer must be shorter than 1500 characters.');
    });
  });
});
