// Mock config for tests - MUST be before any imports that use config. Retries are disabled
// (maxRetries: 0) so withRetry's exponential-backoff does not slow the suite down; the retry
// behavior itself is covered by the dedicated mistral_api tests.
jest.mock('../../config', () => ({
  config: {
    mistral: {
      apiKey: 'test-api-key',
      agentId: 'test-agent-id',
      conversationTtlMs: 12 * 60 * 60 * 1000,
      maxTurnsPerSession: 50,
      handoffRecentTurns: 3,
      handoffWaitMs: 5000,
      apiRoot: 'https://api.test/v1',
      libraryId: 'lib-1',
      nightlyAgentId: 'nightly-agent-1',
      summarizerAgentId: 'summarizer-agent-1',
      requestTimeoutMs: 120000,
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
    nightly: {
      maxRetries: 0
    }
  }
}));

// ChatAgent builds its conversation URLs from the shared Mistral client helper; pin it to a
// fixed value so fetch assertions stay deterministic regardless of config.
jest.mock('../../mistral/mistral_api', () => ({
  ...jest.requireActual('../../mistral/mistral_api'),
  conversationsUrl: () => 'https://test.url'
}));

import { ChatAgent } from '../../chat_agent';
import { config } from '../../config';
import { buildHandoff } from '../../handoff';
import {
  claimNoteDelivery,
  getUndeliveredNotesForUser,
  insertIntradayNote,
  releaseNoteDelivery
} from '../../database/models/intraday_notes.model';

// The outbox model talks to MariaDB; without a mock every prompt build would attempt a real
// connection (see deliverIntradayNotes in chat_agent.ts). The dedicated model tests cover the
// SQL itself; here only the delivery/claim interaction is of interest.
jest.mock('../../database/models/intraday_notes.model', () => ({
  getUndeliveredNotesForUser: jest.fn(),
  claimNoteDelivery: jest.fn(),
  insertIntradayNote: jest.fn(),
  releaseNoteDelivery: jest.fn()
}));

// The context model talks to MariaDB; here its read paths serve the shared test fixture so
// prompt building is deterministic (the SQL itself is covered by the model suites), while
// isKnownPerson stays a plain mock so recipient validation is easy to steer per test.
import { isKnownPerson } from '../../database/models/context.model';
import { TEST_CONTEXT_DATA } from './context_data';

jest.mock('../../database/models/context.model', () => ({
  getAllEntriesFromDb: jest.fn(async () => TEST_CONTEXT_DATA),
  getAllTitlesFromDb: jest.fn(async () => TEST_CONTEXT_DATA.map(record => record.title)),
  getContentByTitleFromDb: jest.fn(
    async (title: string) =>
      TEST_CONTEXT_DATA.find(record => record.title.toLowerCase() === title.toLowerCase())?.content ?? null
  ),
  isKnownPerson: jest.fn()
}));

const mockIsKnownPerson = isKnownPerson as jest.Mock;

// The handoff talks to Mistral through its own client; it has dedicated tests in handoff.test.ts.
jest.mock('../../handoff', () => ({
  ...jest.requireActual('../../handoff'),
  buildHandoff: jest.fn()
}));
const mockBuildHandoff = buildHandoff as jest.Mock;
const mockGetUndeliveredNotesForUser = getUndeliveredNotesForUser as jest.Mock;
const mockClaimNoteDelivery = claimNoteDelivery as jest.Mock;
const mockInsertIntradayNote = insertIntradayNote as jest.Mock;
const mockReleaseNoteDelivery = releaseNoteDelivery as jest.Mock;

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

export {
  ChatAgent,
  config,
  mockFetch,
  mockBuildHandoff,
  mockGetUndeliveredNotesForUser,
  mockClaimNoteDelivery,
  mockInsertIntradayNote,
  mockReleaseNoteDelivery,
  mockIsKnownPerson
};

export function setupChatAgent(): ChatAgent {
  mockFetch.mockClear();
  mockBuildHandoff.mockReset();
  mockGetUndeliveredNotesForUser.mockReset().mockResolvedValue([]);
  mockClaimNoteDelivery.mockReset().mockResolvedValue(true);
  mockInsertIntradayNote.mockReset().mockResolvedValue(1);
  mockReleaseNoteDelivery.mockReset().mockResolvedValue(undefined);
  mockIsKnownPerson.mockReset().mockResolvedValue(true);
  mockBuildHandoff.mockResolvedValue('<previous_conversation>\nHANDOFF\n</previous_conversation>');
  return new ChatAgent('test-api-key', 'test-agent-id');
}
