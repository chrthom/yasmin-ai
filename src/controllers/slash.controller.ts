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

export function createSlashController(chatAgent: ChatAgent, synologyClient: SynologyClient) {
  return async function handleSlashChat(req: Request, res: Response): Promise<void> {
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
      const answer = await processRequest(chatAgent, synologyClient, userText, reqBody.username, true);
      res.status(200).send({
        text: answer
      });
    } catch (error) {
      console.error('ERROR in slash chat processing:', error);
      res.status(500).send({ error: 'Internal server error' });
    }
  };
}
