import * as process from 'node:process';

/**
 * Reads an optional env var, falling back to the given default when it is unset or empty.
 *
 * @param key The environment variable name.
 * @param fallback The value to use when the variable is unset or empty.
 * @returns The variable's value or the fallback.
 */
const optionalEnv = (key: string, fallback: string): string => process.env[key] || fallback;

/**
 * Reads a required env var. Implemented as a lazy getter (not the compile-time-only `!`) so
 * importing config without validateEnv() can never silently yield undefined.
 *
 * @param key The environment variable name.
 * @returns The variable's value.
 * @throws Error when the variable is unset or empty.
 */
const requiredEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

/**
 * Parses an env var as an integer, clamped to [min, max]; absent or unparseable values use the default.
 *
 * @param key The environment variable name.
 * @param defaultValue The value to use when the variable is absent or unparseable.
 * @param min Lower clamp bound (inclusive).
 * @param max Upper clamp bound (inclusive).
 * @returns The parsed, clamped integer value.
 */
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

/**
 * Central application configuration. Env-backed values are either read eagerly with a fallback
 * here or through lazy getters that throw on access (see requiredEnv).
 */
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
    // Hard ceiling for any single Mistral HTTP call made through mistral_api.ts (live turns
    // reprocess the full conversation history and can legitimately exceed 30s).
    requestTimeoutMs: parseClampedEnvInt('REQUEST_TIMEOUT_MS', 120_000, 1, 600_000),
    // Cap on the sequential tool-calling loop in the live agent; a warning is logged when hit.
    maxToolCalls: 5,
    // Without this optional agent the handoff degrades to replaying just the last turns.
    summarizerAgentId: optionalEnv('AGENT_ID_SUMMARIZER', ''),
    // Optional: dedicated Mistral agent for the nightly dream phase. The dream agent may be narrative;
    // without it the dream generation falls back to the structured nightly agent with a creative prompt.
    dreamAgentId: optionalEnv('AGENT_ID_DREAM', '')
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
    history: {
      prevCount: 10,
      botUserId: Number(process.env['CHAT_BOT_USER_ID'] || 0) || 0,
      slashPrefix: '/yasmin',
      fetchTimeoutMs: 5000,
      transcriptMaxCharsPerMessage: 1500
    },
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
    maxIterations: parseClampedEnvInt('NIGHTLY_MAX_ITERATIONS', 25, 1, 200),
    archiveKeepVersions: 10,
    eagerMaxChars: 10000,
    watermarkStalenessMs: 10 * 24 * 60 * 60 * 1000,
    // Dream phase cadence: a nightly probability of ~0.35 yields 2-3 dreams per week on average;
    // once the gap since the last dream reaches dreamMaxGapDays the next night always dreams, so an
    // unlucky random streak can never starve the mechanism.
    dreamProbabilityPerNight: 0.35,
    dreamMaxGapDays: 4,
    // Only journals at least this old may become dream sources (dissociation: widely separated
    // memories generate the non-trivial, cross-cutting connections the dream phase is after).
    dreamMinSourceAgeDays: 7
  }
} as const;

/** Options for {@link validateEnv}, deciding which extra variables a process role requires. */
export interface ValidateEnvOptions {
  /** Set by entrypoints that talk to the database (nightly run, manage-context, bootstrap-memory). */
  requireDb?: boolean;
}

/**
 * Validates that every required env var is set, printing each missing one and exiting the
 * process otherwise. Called explicitly by each entrypoint; never guesses the process role
 * from argv. USE_REAL_DB=true always implies the database variables as well.
 *
 * @param options Set requireDb to also enforce DB_PASSWORD.
 */
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

  if (!Number(process.env['CHAT_BOT_USER_ID'])) {
    console.warn(
      "WARNING: CHAT_BOT_USER_ID is not set or not a number; the bot's own replies cannot be excluded from group channel history."
    );
  }
}
