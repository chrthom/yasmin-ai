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
import { version } from './version';
import { getDatabasePool } from './database/connection';
import { startNightlyScheduler, stopNightlyScheduler } from './nightly/scheduler';

validateEnv();

// Initialize database pool
getDatabasePool();

const chatIncomingBaseURL = config.synology.chatIncomingUrl;

// Shared singletons: the agent is stateful (conversation caches), so there must be exactly one
// per process; the client is effectively stateless but is shared for consistency.
export const chatAgent = new ChatAgent(config.mistral.apiKey, config.mistral.agentId);
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
    version,
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

const NIGHTLY_SHUTDOWN_TIMEOUT_MS = config.nightly.shutdownTimeoutMs;

/**
 * Stop scheduling new nightly runs and let an in-flight pipeline drain within a bounded timeout,
 * so a SIGTERM mid-run doesn't leave a stale processing_lock behind.
 */
const shutdown = async (signal: string): Promise<void> => {
  console.log(`INFO: ${signal} received, shutting down`);
  const drained = await stopNightlyScheduler(NIGHTLY_SHUTDOWN_TIMEOUT_MS);
  if (!drained) {
    console.error(
      'ERROR: nightly pipeline still running after ' +
        String(NIGHTLY_SHUTDOWN_TIMEOUT_MS) +
        'ms; exiting non-zero (a stale processing_lock may need manual recovery)'
    );
  }
  server.close(() => process.exit(drained ? 0 : 1));
};

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
