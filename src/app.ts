import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config, validateEnv } from './config';
import { ChatAgent } from './chat_agent';
import { SynologyClient } from './synology_client';

validateEnv();

const SynologyRequestSchema = z.object({
  text: z.string().min(1).max(config.validation.maxTextLength),
  token: z.string().min(1),
  user_id: z.number().int().positive(),
  username: z.string().min(1).max(config.validation.maxUsernameLength).regex(/^[a-zA-Z0-9_-]+$/),
  post_id: z.number().int().positive().optional(),
  thread_id: z.number().int().positive().optional(),
  timestamp: z.number().int().positive().optional(),
});

const chatIncomingURL = `${config.synology.chatIncomingUrl}?api=SYNO.Chat.External&method=chatbot&version=2&token=`;

export const chatAgent = new ChatAgent(config.mistral.baseUrl, config.mistral.apiKey, config.mistral.agentId);
export const synologyClient = new SynologyClient(chatIncomingURL, config.synology.tokens.bot);

const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
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
  if (reqBody.token != config.synology.tokens.bot) {
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
  if (reqBody.token != config.synology.tokens.slash) {
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
  if (reqBody.token != config.synology.tokens.group) {
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

app.listen(config.server.port, () => {
  console.log(`INFO Yasmin AI API Server started on port ${config.server.port}`);
});

process.on('uncaughtException', err => {
  console.log(`ERROR: Caught exception: ${err.name} -> ${err.message}${err.stack ? '\n' + err.stack : ''}`);
});
