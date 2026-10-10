import * as process from 'node:process';

const optionalEnv = (key: string, fallback: string): string => process.env[key] || fallback;

// Lazy required-getter: throws only when a value is actually read, so importing the config module
// (e.g. in tests or CLIs that never touch a given section) is always safe. Entrypoints additionally
// call validateEnv() to fail fast at startup with the complete list of missing variables.
const requiredEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

export const config = {
  server: {
    port: process.env['PORT'] || 5000
  },
  mistral: {
    get apiKey(): string {
      return requiredEnv('MISTRAL_API_KEY');
    },
    get agentId(): string {
      return requiredEnv('AGENT_ID_CONVERSATION');
    },
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
    // enforces them at startup for all processes.
    get libraryId(): string {
      return requiredEnv('MISTRAL_LIBRARY_ID');
    },
    get nightlyAgentId(): string {
      return requiredEnv('AGENT_ID_NIGHTLY');
    },
    // Optional: Mistral agent that summarizes a conversation for the turn-limit/respawn handoff. Without it
    // the handoff degrades to replaying just the last turns. Kept as a plain (mutable for tests) property.
    summarizerAgentId: optionalEnv('AGENT_ID_SUMMARIZER', '')
  },
  synology: {
    chatIncomingUrl: 'https://thomsen.in/chat/webapi/entry.cgi',
    tokens: {
      get bot(): string {
        return requiredEnv('CHAT_TOKEN_BOT');
      },
      get slash(): string {
        return requiredEnv('CHAT_TOKEN_SLASH');
      },
      get group(): string {
        return requiredEnv('CHAT_TOKEN_GROUP');
      }
    }
  },
  database: {
    host: '192.168.0.2',
    port: 3307,
    user: 'yasmin',
    password: optionalEnv('DB_PASSWORD', ''),
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
    maxIterations: 15,
    archiveKeepVersions: 10,
    eagerMaxChars: 10000,
    watermarkStalenessMs: 10 * 24 * 60 * 60 * 1000
  }
} as const;

export interface ValidateEnvOptions {
  // Set by entrypoints that talk to the database (nightly run, manage-context, bootstrap-memory).
  requireDb?: boolean;
}

// Validate required environment variables. Called explicitly by each entrypoint; never guesses the
// process role from argv. USE_REAL_DB=true always implies the database variables as well.
export function validateEnv(options: ValidateEnvOptions = {}): void {
  const required = [
    'MISTRAL_API_KEY',
    'CHAT_TOKEN_BOT',
    'CHAT_TOKEN_SLASH',
    'CHAT_TOKEN_GROUP',
    'AGENT_ID_CONVERSATION',
    'MISTRAL_LIBRARY_ID',
    'AGENT_ID_NIGHTLY'
  ];
  if (options.requireDb === true || process.env['USE_REAL_DB'] === 'true') {
    required.push('DB_PASSWORD');
  }

  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    missing.forEach(key => console.error(`ERROR: Missing required environment variable: ${key}`));
    process.exit(1);
  }
}
