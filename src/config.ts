import * as process from 'node:process';

export const config = {
  server: {
    port: process.env['PORT'] || 5000
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1/conversations',
    apiKey: process.env['MISTRAL_API_KEY']!,
    agentId: process.env['AGENT_ID_CONVERSATION']!,
    conversationTtlMs: 12 * 60 * 60 * 1000,
    // Turn-based compaction: once a live conversation reaches this many turns it gets closed
    // (not deleted -- the nightly job still journals it) and the next turn starts a fresh one.
    // The Mistral conversation API exposes no cumulative token count, so turns are the proxy.
    maxTurnsPerSession: parseInt(process.env['MAX_TURNS_PER_SESSION'] || '50', 10),
    // How many of the previous conversation's last turns (user + assistant) are replayed verbatim into a
    // fresh conversation, and how long the next turn waits for the background summary before going without.
    handoffRecentTurns: 3,
    handoffWaitMs: 5000,
    apiRoot: 'https://api.mistral.ai/v1',
    // Required for every process: the nightly scheduler runs in-process inside app.ts (same Node process
    // as the API server), so MISTRAL_LIBRARY_ID and AGENT_ID_NIGHTLY are always required. validateEnv()
    // enforces them at startup for all processes, so the `!` is safe -- the server refuses to start
    // without them.
    libraryId: process.env['MISTRAL_LIBRARY_ID']!,
    nightlyAgentId: process.env['AGENT_ID_NIGHTLY']!,
    // Optional: Mistral agent that summarizes a conversation for the turn-limit/respawn handoff. Without it
    // the handoff degrades to replaying just the last turns.
    summarizerAgentId: process.env['AGENT_ID_SUMMARIZER'] || ''
  },
  synology: {
    chatIncomingUrl: 'https://thomsen.in/chat/webapi/entry.cgi',
    tokens: {
      bot: process.env['CHAT_TOKEN_BOT']!,
      slash: process.env['CHAT_TOKEN_SLASH']!,
      group: process.env['CHAT_TOKEN_GROUP']!
    }
  },
  database: {
    host: '192.168.0.2',
    port: 3307,
    user: 'yasmin',
    password: process.env['DB_PASSWORD'] || '',
    name: 'yasmin'
  },
  rateLimit: {
    windowMs: 60 * 1000,
    max: 15
  },
  validation: {
    maxTextLength: 10000,
    maxUsernameLength: 100
  },
  chunk: {
    maxLength: 1800
  },
  nightly: {
    tz: process.env['MEMORY_TZ'] || 'Europe/Berlin',
    maxRetries: parseInt(process.env['NIGHTLY_MAX_RETRIES'] || '3', 10),
    maxRevisions: 3,
    lockStaleMs: 2 * 60 * 60 * 1000,
    maxIterations: parseInt(process.env['NIGHTLY_MAX_ITERATIONS'] || '25', 10),
    archiveKeepVersions: 10,
    eagerMaxChars: 10000,
    watermarkStalenessMs: 10 * 24 * 60 * 60 * 1000
  }
} as const;

// Validate required environment variables
export function validateEnv(): void {
  const requiredEnv = [
    'MISTRAL_API_KEY',
    'CHAT_TOKEN_BOT',
    'CHAT_TOKEN_SLASH',
    'CHAT_TOKEN_GROUP',
    'AGENT_ID_CONVERSATION',
    'MISTRAL_LIBRARY_ID',
    'AGENT_ID_NIGHTLY'
  ] as const;

  requiredEnv.forEach(key => {
    if (!process.env[key]) {
      console.error(`ERROR: Missing required environment variable: ${key}`);
      process.exit(1);
    }
  });

  // Database environment variables are only required if running the CLI context manager or if real DB is explicitly enabled
  const isCli = process.argv[1] && process.argv[1].includes('manage-context');
  const isRealDbEnabled = process.env['USE_REAL_DB'] === 'true';
  const isNightly =
    !!process.argv[1] &&
    (process.argv[1].includes('/nightly/') || process.argv[1].includes('bootstrap-memory'));

  if (isCli || isRealDbEnabled || isNightly) {
    const requiredDbEnv = ['DB_PASSWORD'] as const;
    requiredDbEnv.forEach(key => {
      if (!process.env[key]) {
        console.error(`ERROR: Missing required database environment variable: ${key}`);
        process.exit(1);
      }
    });
  }
}
