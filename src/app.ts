import express from 'express';
import cors from 'cors';
import process from 'node:process';
import { ChatAgent } from './chat_agent';
import { SynologyClient } from './synology_client';

interface SynologyRequest {
  token: string;
  user_id: number;
  username: string;
  post_id?: number;
  thread_id?: number;
  timestamp?: number;
  text: string;
}

const mistralApiKey = <string>process.env['MISTRAL_API_KEY'];
const chatTokenBot = <string>process.env['CHAT_TOKEN_BOT'];
const chatTokenSlash = <string>process.env['CHAT_TOKEN_SLASH'];
const chatTokenGroup = <string>process.env['CHAT_TOKEN_GROUP'];
const agentId = <string>process.env['AGENT_ID'];
const mistralURL = 'https://api.mistral.ai/v1/conversations';
const chatIncomingURL =
  'https://thomsen.in/chat/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=';

const chatAgent = new ChatAgent(mistralURL, mistralApiKey, agentId);
const synologyClient = new SynologyClient(chatIncomingURL, chatTokenBot);

async function processRequest(
  userText: string,
  username: string,
  shortAnswer: boolean = false
): Promise<string> {
  return chatAgent.processRequest(userText, username, shortAnswer).then(t => synologyClient.formatAnswer(t));
}

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.post('/chat/bot', (req, res) => {
  const reqBody = <SynologyRequest>req.body;
  console.log(`INFO Bot Chat called - Body : ${JSON.stringify(reqBody)} Headers: ${req.get('Content-Type')}`);
  if (reqBody.token != chatTokenBot) {
    console.log('WARN Previous Bot Chat request has invalid authorization token');
    res.sendStatus(401);
  } else {
    processRequest(reqBody.text, reqBody.username).then(answer => {
      const answers = synologyClient.chunkText(answer);
      res.sendStatus(202);
      synologyClient.sendAnswersToChat(reqBody.user_id, answers);
    });
  }
});

app.post('/chat/slash', (req, res) => {
  const reqBody = <SynologyRequest>req.body;
  console.log(
    `INFO Slash Chat called - Body : ${JSON.stringify(reqBody)} Headers: ${req.get('Content-Type')}`
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
    `INFO Group Chat called - Body : ${JSON.stringify(reqBody)} Headers: ${req.get('Content-Type')}`
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

app.get('/test', (req, res) => {
  res.status(200).send({ text: 'Test!' });
});

app.listen(5000, () => {
  console.log('Yasmin AI API Server started');
});

process.on('uncaughtException', err => {
  console.log(`ERROR: Caught exception: ${err.name} -> ${err.message}${err.stack ? '\n' + err.stack : ''}`);
});
