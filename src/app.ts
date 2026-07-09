import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { config, validateEnv } from './config';
import { ChatAgent } from './chat_agent';
import { SynologyClient } from './synology_client';
import {
  createBotController,
  createSlashController,
  createGroupController
} from './controllers/chat.controller';
import { requestTracingMiddleware, getRequestId } from './middleware/requestTracing';
import { openApiSpec } from './openapi';
import { getDatabasePool } from './database/connection';
import { startNightlyScheduler, stopNightlyScheduler } from './nightly/scheduler';

validateEnv();

// Initialize database pool
getDatabasePool();

const chatIncomingBaseURL = config.synology.chatIncomingUrl;

export const chatAgent = new ChatAgent(config.mistral.baseUrl, config.mistral.apiKey, config.mistral.agentId);
export const synologyClient = new SynologyClient(chatIncomingBaseURL, config.synology.tokens.bot);

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

app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(openApiSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Yasmin AI API Documentation'
  })
);

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

const server = app.listen(config.server.port, () => {
  console.log(`INFO Yasmin AI API Server started on port ${config.server.port}`);
  console.log(`INFO API Documentation available at http://localhost:${config.server.port}/api-docs`);
});

startNightlyScheduler();

process.on('uncaughtException', err => {
  console.error('Uncaught Exception:', err);
  server.close(() => process.exit(1));
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  server.close(() => process.exit(1));
});

process.on('SIGTERM', () => {
  console.log('INFO: SIGTERM received, shutting down');
  stopNightlyScheduler();
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('INFO: SIGINT received, shutting down');
  stopNightlyScheduler();
  server.close(() => process.exit(0));
});
