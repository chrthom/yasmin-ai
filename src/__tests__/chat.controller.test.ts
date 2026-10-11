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
});
