import * as process from 'node:process';

const optionalEnv = (key: string, fallback: string): string => process.env[key] || fallback;

// Lazy getters throw on access instead of the compile-time-only `!`, so importing config without
// validateEnv() can never silently yield undefined.
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
    // Turns are the compaction proxy because the Mistral conversation API exposes no token count.
    maxTurnsPerSession: parseInt(process.env['MAX_TURNS_PER_SESSION'] || '50', 10),
    handoffRecentTurns: 3,
    handoffWaitMs: 5000,
    apiRoot: 'https://api.mistral.ai/v1',
    // validateEnv() enforces these at startup; requiredEnv guards reads in non-entrypoint processes.
    get libraryId(): string {
      return requiredEnv('MISTRAL_LIBRARY_ID');
    },
    get nightlyAgentId(): string {
      return requiredEnv('AGENT_ID_NIGHTLY');
    },
    // Without this optional agent the handoff degrades to replaying just the last turns.
    summarizerAgentId: optionalEnv('AGENT_ID_SUMMARIZER', ''),
    // Hard timeout for one live (interactive) Mistral HTTP call; the nightly pipeline keeps
    // its tighter 30s ceiling. Non-numeric or non-positive values fall back to the default
    // (a NaN would abort every live request immediately, since setTimeout(abort, NaN) fires at once).
    chatRequestTimeoutMs: (() => {
      const parsed = parseInt(optionalEnv('CHAT_REQUEST_TIMEOUT_MS', '120000'), 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 120000;
    })()
  },  synology: {
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
    // Empty only when the DB is genuinely unused; validateEnv({ requireDb: true }) enforces it otherwise.
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

// Called explicitly by each entrypoint; never guesses the process role from argv.
// USE_REAL_DB=true always implies the database variables as well.
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
