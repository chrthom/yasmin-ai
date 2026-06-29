import { Request, Response } from 'express';
import { SynologyRequestSchema } from '../middleware/validation';
import { config } from '../config';
import { ChatAgent } from '../chat_agent';
import { SynologyClient } from '../synology_client';

async function processRequest(
  chatAgent: ChatAgent,
  synologyClient: SynologyClient,
  userText: string,
  username: string,
  shortAnswer: boolean = false
): Promise<string> {
  const outputs = await chatAgent.processRequest(userText, username, shortAnswer);
  const text = chatAgent.convertMultiPart(outputs);
  return synologyClient.formatAnswer(text);
}

export function createBotController(chatAgent: ChatAgent, synologyClient: SynologyClient) {
  return async function handleBotChat(req: Request, res: Response): Promise<void> {
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
      const answer = await processRequest(chatAgent, synologyClient, reqBody.text, reqBody.username);
      res.sendStatus(202);
      await synologyClient.sendAnswersToChat(reqBody.user_id, synologyClient.chunkText(answer).reverse());
    } catch (error) {
      console.error('ERROR in bot chat processing:', error);
      res.status(500).send({ error: 'Internal server error' });
    }
  };
}
