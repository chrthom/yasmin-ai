import * as process from 'node:process';

/** Parses an env var as an integer, clamped to [min, max]; absent or unparseable values use the default. */
function parseClampedEnvInt(key: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }
  return Math.min(Math.max(parsed, min), max);
}

export const config = {
  server: {
    port: process.env['PORT'] || 5000
  },
  mistral: {
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
    // Hard ceiling for any single Mistral HTTP call made through mistral_api.ts.
    requestTimeoutMs: 30_000,
    // Cap on the sequential tool-calling loop in the live agent. When it is hit, remaining
    // tool calls are dropped (a warning is logged) and the final outputs are returned as-is.
    maxToolCalls: 5,
    // Optional: Mistral agent that summarizes a conversation for the turn-limit/respawn handoff. Without it
    // the handoff degrades to replaying just the last turns.
    summarizerAgentId: process.env['AGENT_ID_SUMMARIZER'] || ''
  },
  context: {
    familyNotesTitle: 'Family notes',
    profileOfYasminTitle: 'Profile of Yasmin'
  },
  chat: {
    // Hard cap on the content of a share_note staged for another person.
    noteContentMaxChars: 500,
    noteToEveryone: 'everyone',
    // Upper bound enforced by the shortAnswer request flag. The prompt string built from it and
    // the matching cleanup regex live in src/protocol.ts, so they cannot drift apart.
    shortAnswerMaxChars: 1500
  },
  handoff: {
    recentMessageMaxChars: 600,
    summaryMaxChars: 2500,
    summarizerInputMaxChars: 30000,
    summarizerTurnMaxChars: 1500
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
    // Scheduled start time of the nightly run (local time in tz). An unparseable or out-of-range
    // value falls back to the default instead of silently rescheduling the nightly run.
    hour: parseClampedEnvInt('NIGHTLY_HOUR', 23, 0, 23),
    minute: parseClampedEnvInt('NIGHTLY_MINUTE', 0, 0, 59),
    transcriptMaxChars: 20000,
    journalSoftCapChars: 4000,
    shutdownTimeoutMs: 30_000,
    maxRetries: parseInt(process.env['NIGHTLY_MAX_RETRIES'] || '3', 10),
    maxRevisions: 3,
    lockStaleMs: 2 * 60 * 60 * 1000,
    maxIterations: 15,
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
