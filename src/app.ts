import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import process from 'node:process';
import { z } from 'zod';
import { ChatAgent } from './chat_agent';
import { SynologyClient } from './synology_client';

const SynologyRequestSchema = z.object({
  text: z.string().min(1).max(10000),
  token: z.string().min(1),
  user_id: z.number().int().positive(),
  username: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  post_id: z.number().int().positive().optional(),
  thread_id: z.number().int().positive().optional(),
  timestamp: z.number().int().positive().optional(),
});

const requiredEnv = [
  'MISTRAL_API_KEY',
  'CHAT_TOKEN_BOT',
  'CHAT_TOKEN_SLASH',
  'CHAT_TOKEN_GROUP',
  'AGENT_ID'
];

requiredEnv.forEach(key => {
  if (!process.env[key]) {
    console.error(`ERROR: Missing required environment variable: ${key}`);
    process.exit(1);
  }
});

const mistralApiKey = process.env['MISTRAL_API_KEY']!;
const chatTokenBot = process.env['CHAT_TOKEN_BOT']!;
const chatTokenSlash = process.env['CHAT_TOKEN_SLASH']!;
const chatTokenGroup = process.env['CHAT_TOKEN_GROUP']!;
const agentId = process.env['AGENT_ID']!;
const mistralURL = 'https://api.mistral.ai/v1/conversations';
const chatIncomingURL =
  'https://thomsen.in/chat/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=';

export const chatAgent = new ChatAgent(mistralURL, mistralApiKey, agentId);
export const synologyClient = new SynologyClient(chatIncomingURL, chatTokenBot);

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: 'Too many requests, please try again later.',
  headers: true,
});

async function processRequest(
  userText: string,
  username: string,
  shortAnswer: boolean = false
): Promise<string> {
  const outputs = await chatAgent.processRequest(userText, username, shortAnswer);
  const text = chatAgent.convertMultiPart(outputs);
  return synologyClient.formatAnswer(text);
}

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(limiter);

app.post('/chat/bot', async (req, res) => {
  const parseResult = SynologyRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    console.log('WARN Invalid request body:', parseResult.error.format());
    res.status(400).send({ error: 'Invalid request body' });
    return;
  }
  const reqBody = parseResult.data;
  const redactedBody = { ...reqBody, token: '***REDACTED***' };
  console.log(
    `DEBUG Bot Chat called - Body: ${JSON.stringify(redactedBody)} Headers: ${req.get('Content-Type')}`
  );
  if (reqBody.token != chatTokenBot) {
    console.log('WARN Bot Chat request has invalid authorization token');
    res.sendStatus(401);
    return;
  }
  try {
    const answer = await processRequest(reqBody.text, reqBody.username);
    res.sendStatus(202);
    await synologyClient.sendAnswersToChat(reqBody.user_id, synologyClient.chunkText(answer).reverse());
  } catch (error) {
    console.error('ERROR in bot chat processing:', error);
    res.status(500).send({ error: 'Internal server error' });
  }
});

app.post('/chat/slash', async (req, res) => {
  const parseResult = SynologyRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    console.log('WARN Invalid request body:', parseResult.error.format());
    res.status(400).send({ error: 'Invalid request body' });
    return;
  }
  const reqBody = parseResult.data;
  const redactedBody = { ...reqBody, token: '***REDACTED***' };
  console.log(
    `DEBUG Slash Chat called - Body: ${JSON.stringify(redactedBody)} Headers: ${req.get('Content-Type')}`
  );
  if (reqBody.token != chatTokenSlash) {
    console.log('WARN Slash Chat request has invalid authorization token');
    res.sendStatus(401);
    return;
  }
  try {
    const userText = reqBody.text.replace('/yasmin', '').trim();
    const answer = await processRequest(userText, reqBody.username, true);
    res.status(200).send({
      text: answer
    });
  } catch (error) {
    console.error('ERROR in slash chat processing:', error);
    res.status(500).send({ error: 'Internal server error' });
  }
});

app.post('/chat/group', async (req, res) => {
  const parseResult = SynologyRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    console.log('WARN Invalid request body:', parseResult.error.format());
    res.status(400).send({ error: 'Invalid request body' });
    return;
  }
  const reqBody = parseResult.data;
  const redactedBody = { ...reqBody, token: '***REDACTED***' };
  console.log(
    `DEBUG Group Chat called - Body: ${JSON.stringify(redactedBody)} Headers: ${req.get('Content-Type')}`
  );
  if (reqBody.token != chatTokenGroup) {
    console.log('WARN Group Chat request has invalid authorization token');
    res.sendStatus(401);
    return;
  }
  try {
    const answer = await processRequest(reqBody.text, reqBody.username, true);
    res.status(200).send({
      text: answer
    });
  } catch (error) {
    console.error('ERROR in group chat processing:', error);
    res.status(500).send({ error: 'Internal server error' });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
    uptime: process.uptime()
  });
});

app.listen(5000, () => {
  console.log('INFO Yasmin AI API Server started');
});

process.on('uncaughtException', err => {
  console.log(`ERROR: Caught exception: ${err.name} -> ${err.message}${err.stack ? '\n' + err.stack : ''}`);
});
