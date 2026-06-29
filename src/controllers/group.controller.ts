import { Request, Response } from 'express';
import { SynologyRequestSchema } from '../middleware/validation';
import { config } from '../config';
import { ChatAgent } from '../chat_agent';
import { SynologyClient } from '../synology_client';
import { createRequestLogger } from '../middleware/requestTracing';

async function processRequest(
  chatAgent: ChatAgent,
  synologyClient: SynologyClient,
  userText: string,
  username: string,
  shortAnswer: boolean = false
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

export function createGroupController(chatAgent: ChatAgent, synologyClient: SynologyClient) {
  return async function handleGroupChat(req: Request, res: Response): Promise<void> {
    const logger = createRequestLogger(req);
    const parseResult = SynologyRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      logger.warn('Invalid request body', { error: parseResult.error.format() });
      res.status(400).send({ error: 'Invalid request body' });
      return;
    }
    const reqBody = parseResult.data;
    const redactedBody = { ...reqBody, token: '***REDACTED***' };
    logger.debug('Group Chat called', { body: redactedBody, contentType: req.get('Content-Type') });
    if (!reqBody.token || reqBody.token != config.synology.tokens.group) {
      logger.warn('Group Chat request has invalid authorization token');
      res.sendStatus(401);
      return;
    }
    try {
      const answer = await processRequest(chatAgent, synologyClient, reqBody.text, reqBody.username, true);
      res.status(200).send({ text: answer });
      await synologyClient
        .sendAnswersToChat(reqBody.user_id, synologyClient.chunkText(answer).reverse())
        .catch(error => logger.error('Failed to send group response to Synology', { error }));
    } catch (error) {
      logger.error('Error in group chat processing', { error });
      res.status(500).send({ error: 'Internal server error' });
    }
  };
}
