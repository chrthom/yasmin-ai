import * as process from 'node:process';

export const config = {
  server: {
    port: process.env['PORT'] || 5000
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1/conversations',
    apiKey: process.env['MISTRAL_API_KEY']!,
    agentId: process.env['AGENT_ID']!,
    conversationTtlMs: 12 * 60 * 60 * 1000
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
    host: process.env['DB_HOST'] || 'localhost',
    port: parseInt(process.env['DB_PORT'] || '3306', 10),
    user: process.env['DB_USER']!,
    password: process.env['DB_PASSWORD']!,
    name: process.env['DB_NAME']!
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
  }
} as const;

// Validate required environment variables
export function validateEnv(): void {
  const requiredEnv = [
    'MISTRAL_API_KEY',
    'CHAT_TOKEN_BOT',
    'CHAT_TOKEN_SLASH',
    'CHAT_TOKEN_GROUP',
    'AGENT_ID',
    'DB_HOST',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME'
  ] as const;

  requiredEnv.forEach(key => {
    if (!process.env[key]) {
      console.error(`ERROR: Missing required environment variable: ${key}`);
      process.exit(1);
    }
  });
}
