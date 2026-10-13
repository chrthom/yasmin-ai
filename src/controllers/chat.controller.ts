import { Request, Response } from 'express';
import { SynologyRequestSchema } from '../middleware/validation';
import { config } from '../config';
import { ChatAgent } from '../chat_agent';
import { SynologyClient } from '../synology_client';
import { createRequestLogger } from '../middleware/requestTracing';

/** Options that distinguish the three chat endpoints (bot/slash/group) on top of the shared handler. */
interface ChatControllerOptions {
  /** The endpoint's expected authentication token. */
  token: string;
  /** 202 acknowledges and delivers asynchronously via Synology Chat; 200 answers synchronously. */
  responseStatus: number;
  /** Whether the agent is asked to keep the answer short (slash/group) or not (bot). */
  shortAnswer: boolean;
  /** Optional prefix to strip from the user text (e.g. '/yasmin' for slash commands). */
  stripPrefix?: string;
  /** Whether the answer is additionally pushed to Synology Chat (bot only). */
  sendToSynology?: boolean;
}

/**
 * Runs one user turn through the chat agent and formats the answer for Synology Chat.
 *
 * @param chatAgent The live conversation agent.
 * @param synologyClient The client used for answer formatting.
 * @param userText The (already prefix-stripped) message text.
 * @param username The sender's username.
 * @param shortAnswer Whether the agent must keep the answer short.
 * @returns The formatted answer, or an empty string when the agent produced no text.
 * @throws Error when the agent call fails (replaced by a generic error to avoid leaking details).
 */
async function processRequest(
  chatAgent: ChatAgent,
  synologyClient: SynologyClient,
  userText: string,
  username: string,
  shortAnswer: boolean
): Promise<string> {
  try {
    const outputs = await chatAgent.processRequest(userText, username, shortAnswer);
    const text = chatAgent.convertMultiPart(outputs);
    return text ? synologyClient.formatAnswer(text) : '';
  } catch (error) {
    console.error('Error in processRequest:', error);
    throw new Error('Failed to process chat request');
  }
}

/**
 * Builds the request handler shared by all three chat endpoints: validates the body schema and
 * token, processes the turn, then answers synchronously (200) or acknowledges (202) -- and, when
 * configured, additionally delivers the chunked answer to Synology Chat.
 *
 * @param chatAgent The live conversation agent.
 * @param synologyClient The Synology Chat client for formatting and delivery.
 * @param options Endpoint-specific behavior (token, response status, prefix, delivery).
 * @returns The express request handler for the endpoint.
 */
export function createChatController(
  chatAgent: ChatAgent,
  synologyClient: SynologyClient,
  options: ChatControllerOptions
) {
  return async function handleChat(req: Request, res: Response): Promise<void> {
    const logger = createRequestLogger(req);
    const parseResult = SynologyRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      logger.warn('Invalid request body', { error: parseResult.error.format() });
      res.status(400).send({ error: 'Invalid request body' });
      return;
    }
    const reqBody = parseResult.data;
    const redactedBody = { ...reqBody, token: '***REDACTED***' };
    logger.debug('Chat called', {
      body: redactedBody,
      contentType: req.get('Content-Type')
    });
    if (!reqBody.token || reqBody.token != options.token) {
      logger.warn('Chat request has invalid authorization token');
      res.sendStatus(401);
      return;
    }
    try {
      let userText = reqBody.text;
      if (options.stripPrefix) {
        userText = userText.replace(options.stripPrefix, '').trim();
      }

      const answer = await processRequest(
        chatAgent,
        synologyClient,
        userText,
        reqBody.username,
        options.shortAnswer
      );

      if (options.responseStatus === 200) {
        res.status(200).send({ text: answer });
      } else {
        res.sendStatus(202);
      }

      if (options.sendToSynology !== false) {
        await synologyClient
          .sendAnswersToChat(reqBody.user_id, synologyClient.chunkText(answer))
          .catch(error => logger.error('Failed to send to Synology', { error }));
      }
    } catch (error) {
      logger.error('Error in chat processing', { error });
      res.status(500).send({ error: 'Internal server error' });
    }
  };
}

/** Handler factory for /chat/bot: async webhook delivery -- 202 response plus a Synology Chat push. */
export function createBotController(chatAgent: ChatAgent, synologyClient: SynologyClient) {
  return createChatController(chatAgent, synologyClient, {
    token: config.synology.tokens.bot,
    responseStatus: 202,
    shortAnswer: false,
    sendToSynology: true
  });
}

/** Handler factory for /chat/slash: synchronous short answers with the '/yasmin' prefix stripped. */
export function createSlashController(chatAgent: ChatAgent, synologyClient: SynologyClient) {
  return createChatController(chatAgent, synologyClient, {
    token: config.synology.tokens.slash,
    responseStatus: 200,
    shortAnswer: true,
    stripPrefix: '/yasmin',
    sendToSynology: false
  });
}

/** Handler factory for /chat/group: synchronous short answers for group conversations. */
export function createGroupController(chatAgent: ChatAgent, synologyClient: SynologyClient) {
  return createChatController(chatAgent, synologyClient, {
    token: config.synology.tokens.group,
    responseStatus: 200,
    shortAnswer: true,
    sendToSynology: false
  });
}
