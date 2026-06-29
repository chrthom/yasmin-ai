import express from 'express';
import cors from 'cors';
import process from 'node:process';
import { ChatAgent } from './chat_agent';
import { SynologyClient } from './synology_client';

interface SynologyRequest {
  text: string;
  token: string;
  user_id: number;
  username: string;
  post_id?: number;
  thread_id?: number;
  timestamp?: number;
}

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

const mistralApiKey = process.env['MISTRAL_API_KEY'];
const chatTokenBot = process.env['CHAT_TOKEN_BOT'];
const chatTokenSlash = process.env['CHAT_TOKEN_SLASH'];
const chatTokenGroup = process.env['CHAT_TOKEN_GROUP'];
const agentId = process.env['AGENT_ID'];
const mistralURL = 'https://api.mistral.ai/v1/conversations';
const chatIncomingURL =
  'https://thomsen.in/chat/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=';

export const chatAgent = new ChatAgent(mistralURL, mistralApiKey, agentId);
export const synologyClient = new SynologyClient(chatIncomingURL, chatTokenBot);

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

app.post('/chat/bot', (req, res) => {
  const reqBody = <SynologyRequest>req.body;
  console.log(
    `DEBUG Bot Chat called - Body : ${JSON.stringify(reqBody)} Headers: ${req.get('Content-Type')}`
  );
  if (reqBody.token != chatTokenBot) {
    console.log('WARN Previous Bot Chat request has invalid authorization token');
    res.sendStatus(401);
  } else {
    processRequest(reqBody.text, reqBody.username).then(answer => {
      res.sendStatus(202);
      synologyClient.sendAnswersToChat(reqBody.user_id, synologyClient.chunkText(answer).reverse());
    });
  }
});

app.post('/chat/slash', (req, res) => {
  const reqBody = <SynologyRequest>req.body;
  console.log(
    `DEBUG Slash Chat called - Body : ${JSON.stringify(reqBody)} Headers: ${req.get('Content-Type')}`
  );
  if (reqBody.token != chatTokenSlash) {
    console.log('WARN Previous Slash Chat request has invalid authorization token');
    res.sendStatus(401);
  } else {
    const userText = reqBody.text.replace('/yasmin', '').trim();
    processRequest(userText, reqBody.username, true).then(answer =>
      res.status(200).send({
        text: answer
      })
    );
  }
});

app.post('/chat/group', (req, res) => {
  const reqBody = <SynologyRequest>req.body;
  console.log(
    `DEBUG Group Chat called - Body : ${JSON.stringify(reqBody)} Headers: ${req.get('Content-Type')}`
  );
  if (reqBody.token != chatTokenGroup) {
    console.log('WARN Previous Group Chat request has invalid authorization token');
    res.sendStatus(401);
  } else {
    processRequest(reqBody.text, reqBody.username, true).then(answer =>
      res.status(200).send({
        text: answer
      })
    );
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
