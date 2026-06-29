import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { config, validateEnv } from './config';
import { ChatAgent } from './chat_agent';
import { SynologyClient } from './synology_client';
import { createBotController } from './controllers/bot.controller';
import { createSlashController } from './controllers/slash.controller';
import { createGroupController } from './controllers/group.controller';
import { requestTracingMiddleware, getRequestId } from './middleware/requestTracing';
import { openApiSpec } from './openapi';

validateEnv();

const chatIncomingURL = `${config.synology.chatIncomingUrl}?api=SYNO.Chat.External&method=chatbot&version=2&token=`;

export const chatAgent = new ChatAgent(config.mistral.baseUrl, config.mistral.apiKey, config.mistral.agentId);
export const synologyClient = new SynologyClient(chatIncomingURL, config.synology.tokens.bot);

const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  message: 'Too many requests, please try again later.',
  headers: true
});

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(requestTracingMiddleware);
app.use(limiter);

// API Documentation
app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(openApiSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Yasmin AI API Documentation'
  })
);

// Controllers
const botController = createBotController(chatAgent, synologyClient);
const slashController = createSlashController(chatAgent, synologyClient);
const groupController = createGroupController(chatAgent, synologyClient);

app.post('/chat/bot', botController);
app.post('/chat/slash', slashController);
app.post('/chat/group', groupController);

app.get('/health', (req, res) => {
  const requestId = getRequestId(req);
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
    uptime: process.uptime(),
    requestId
  });
});

app.listen(config.server.port, () => {
  console.log(`INFO Yasmin AI API Server started on port ${config.server.port}`);
  console.log(`INFO API Documentation available at http://localhost:${config.server.port}/api-docs`);
});

process.on('uncaughtException', err => {
  console.log(`ERROR: Caught exception: ${err.name} -> ${err.message}${err.stack ? '\n' + err.stack : ''}`);
});
