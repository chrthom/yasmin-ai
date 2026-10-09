import { Request, Response } from 'express';
import { SynologyRequestSchema } from '../middleware/validation';
import { config } from '../config';
import { ChatAgent } from '../chat_agent';
import { SynologyClient } from '../synology_client';
import { createRequestLogger } from '../middleware/requestTracing';

interface ChatControllerOptions {
  token: string;
  responseStatus: number;
  stripPrefix?: string;
  sendToSynology?: boolean;
  includeChannelHistory?: boolean;
}

async function processRequest(
  chatAgent: ChatAgent,
  synologyClient: SynologyClient,
  userText: string,
  username: string,
  shortAnswer: boolean,
  channelContext?: string
): Promise<string> {
  try {
    let prompt = userText;
    if (channelContext) {
      prompt =
        `${channelContext}\n\n` +
        'The transcript above shows the recent channel conversation. ' +
        `Answer the following message from ${username}:\n${userText}`;
    }
    const outputs = await chatAgent.processRequest(prompt, username, shortAnswer);
    const text = chatAgent.convertMultiPart(outputs);
    return text ? synologyClient.formatAnswer(text) : '';
  } catch (error) {
    console.error('Error in processRequest:', error);
    throw new Error('Failed to process chat request');
  }
}

async function fetchChannelHistory(
  synologyClient: SynologyClient,
  logger: ReturnType<typeof createRequestLogger>,
  channelId: number,
  postId: number,
  botUserId: number
): Promise<string | undefined> {
  try {
    const posts = await synologyClient.fetchPreviousMessages(
      channelId,
      postId,
      config.synology.history.prevCount
    );
    const transcript = synologyClient.formatChannelHistory(posts, botUserId);
    if (!transcript) return undefined;
    return `<channel_history>\n${transcript}\n</channel_history>`;
  } catch (error) {
    logger.warn('Failed to fetch channel history; continuing without it', { error });
    return undefined;
  }
}

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

      const isShortAnswer = options.responseStatus === 200;
      let channelContext: string | undefined;
      if (options.includeChannelHistory && reqBody.channel_id && reqBody.post_id) {
        channelContext = await fetchChannelHistory(
          synologyClient,
          logger,
          reqBody.channel_id,
          reqBody.post_id,
          config.synology.history.botUserId
        );
      }
      const answer = await processRequest(
        chatAgent,
        synologyClient,
        userText,
        reqBody.username,
        isShortAnswer,
        channelContext
      );

      if (options.responseStatus === 200) {
        res.status(200).send({ text: answer });
      } else {
        res.sendStatus(202);
      }

      if (options.sendToSynology !== false) {
        await synologyClient
          .sendAnswersToChat(reqBody.user_id, synologyClient.chunkText(answer).reverse())
          .catch(error => logger.error('Failed to send to Synology', { error }));
      }
    } catch (error) {
      logger.error('Error in chat processing', { error });
      res.status(500).send({ error: 'Internal server error' });
    }
  };
}

export function createBotController(chatAgent: ChatAgent, synologyClient: SynologyClient) {
  return createChatController(chatAgent, synologyClient, {
    token: config.synology.tokens.bot,
    responseStatus: 202,
    sendToSynology: true
  });
}

export function createSlashController(chatAgent: ChatAgent, synologyClient: SynologyClient) {
  return createChatController(chatAgent, synologyClient, {
    token: config.synology.tokens.slash,
    responseStatus: 200,
    stripPrefix: '/yasmin',
    sendToSynology: false
  });
}

export function createGroupController(chatAgent: ChatAgent, synologyClient: SynologyClient) {
  return createChatController(chatAgent, synologyClient, {
    token: config.synology.tokens.group,
    responseStatus: 200,
    sendToSynology: false,
    includeChannelHistory: true
  });
}
