import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import process from 'node:process';

interface SynologyRequest {
  token: string;
  user_id: number;
  username: string;
  post_id: number;
  thread_id: number;
  timestamp: number;
  text: string;
}

interface MistralResponseChoicesMessage {
  content: string;
}

interface MistralResponseChoices {
  message: MistralResponseChoicesMessage;
}

interface MistralResponse {
  choices: MistralResponseChoices[];
}

const mistralApiKey = <string>process.env['MISTRAL_API_KEY'];
const mistralURL = 'https://api.mistral.ai/v1/chat/completions';
const chatTokenBot = <string>process.env['CHAT_TOKEN_BOT'];
const chatTokenSlash = <string>process.env['CHAT_TOKEN_SLASH'];
const chatTokenGroup = <string>process.env['CHAT_TOKEN_GROUP'];
const chatIncomingURL =
  'https://thomsen.in/chat/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=';

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildSystemPrompt(text: string, username: string, shortAnswer: boolean): string {
  return `
    You are a helpful chatbot named Yasmin. 
    Use the informal form to address the user.
    You are talking to ${capitalize(username)}.
    Answer in the language used by ${capitalize(username)}.
    If a question is asked give a personalized answer.
    ${shortAnswer ? 'Your answer should have less than 1900 characters' : ''}
  `;
}

function buildPrefixPrompt(): string {
  return 'Yasmin (Home assistant of Thomsen family):';
}

function splitter(str: string, l: number = 1800) {
  const strs = [];
  while (str.length > l) {
    let pos = str.substring(0, l).lastIndexOf('\n');
    pos = pos <= 0 ? l : pos;
    strs.push(str.substring(0, pos));
    let i = str.indexOf('\n', pos) + 1;
    if (i < pos || i > pos + l) i = pos;
    str = str.substring(i);
  }
  strs.push(str);
  return strs;
}

function queryMistral(userText: string, username: string, shortAnswer: boolean = false): Promise<string> {
  const prefixPrompt = buildPrefixPrompt();
  const mistralBody = {
    model: 'mistral-medium-latest',
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt(userText, username, shortAnswer)
      },
      {
        role: 'user',
        content: userText
      },
      {
        role: 'assistant',
        content: prefixPrompt,
        prefix: true
      }
    ]
  };
  return fetch(mistralURL, {
    method: 'post',
    body: JSON.stringify(mistralBody),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${mistralApiKey}`
    }
  })
    .then(x => {
      console.log(`INFO Received raw answer from mistral: ${x}`);
      return x;
    })
    .then(x => x.json())
    .then(mistralRes =>
      formatMistralAnswer(
        (<MistralResponse>mistralRes).choices[0].message.content.slice(prefixPrompt.length)
      ).trim()
    );
}

function formatMistralAnswer(answer: string): string {
  return answer
    .replaceAll(/^- /gm, '* ')
    .replaceAll(/\*\*([^*]+)\*\* ?/gm, '*$1* ')
    .replaceAll(/^#+ (.*)$/gm, '*_$1_*');
}

async function sendAnswersToChat(userId: number, answers: string[]) {
  if (answers) {
    fetch(`${chatIncomingURL}%22${chatTokenBot}%22`, {
      method: 'post',
      body: new URLSearchParams([
        [
          'payload',
          JSON.stringify({
            text: answers.pop(),
            user_ids: [userId]
          })
        ]
      ]),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }).then(() => sendAnswersToChat(userId, answers));
  }
}

const app = express();
app.use(cors());
app.use(express.urlencoded());

app.post('/chat/bot', (req, res) => {
  const reqBody = <SynologyRequest>req.body;
  console.log(`INFO Bot Chat called - Body : ${JSON.stringify(reqBody)} Headers: ${req.get('Content-Type')}`);
  if (reqBody.token != chatTokenBot) {
    console.log('WARN Previous Bot Chat request has invalid authorization token');
    res.sendStatus(401);
  } else {
    queryMistral(reqBody.text, reqBody.username).then(answer => {
      const answers = splitter(answer);
      res.sendStatus(202);
      sendAnswersToChat(reqBody.user_id, answers);
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
    queryMistral(userText, reqBody.username, true).then(answer =>
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
    queryMistral(reqBody.text, reqBody.username, true).then(answer =>
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
