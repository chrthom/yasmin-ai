import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

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
const chatIncomingURL =
  'https://thomsen.in/chat/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=';

/*
const sampleAnswer: Promise<string> = Promise.resolve(
  'Guten Morgen! Natürlich, ich kann dir eine allgemeine Anleitung zur Montage einer neuen Heizung geben. Diese Anleitung ist jedoch sehr vereinfacht und sollte von einem Fachmann durchgeführt werden, um sicherzustellen, dass alles korrekt und sicher installiert wird. Hier sind die grundlegenden Schritte:\n\n### 1. Vorbereitung\n- **Materialien und Werkzeuge**: Stelle sicher, dass du alle notwendigen Materialien und Werkzeuge hast, wie z.B. Heizungsgerät, Rohre, Schrauben, Klemmen, Dichtungen, Werkzeuge zur Montage und Messgeräte.\n- **Sicherheitsvorkehrungen**: Schalte die Stromversorgung ab und entferne die alte Heizung, falls vorhanden.\n- **Planung**: Plane die Installation und überprüfe die Abmessungen und Platzierung der neuen Heizung.\n\n### 2. Rohrleitung\n- **Rohrverlegung**: Installiere die Rohrleitung, die die Heizung mit dem Wasser- oder Gasversorgungssystem verbindet. Dies kann durch das Einlegen der Rohre in die Wände oder Decken erfolgen.\n- **Verbindung**: Verbinde die Rohre mit den entsprechenden Verbindungen und Klemmen. Stelle sicher, dass alle Verbindungen sicher und dicht sind.\n\n### 3. Heizungsgerät\n- **Montage**: Montiere das Heizungsgerät an der gewünschten Stelle. Dies kann an einer Wand, Decke oder Boden sein.\n- **Verbindung**: Verbinde das Heizungsgerät mit der Rohrleitung. Dies kann durch Schrauben, Klemmen oder andere Befestigungsmittel erfolgen.\n\n### 4. Elektrische Verbindungen\n- **Kabel**: Verbinde die elektrischen Kabel des Heizungsgeräts mit dem Stromnetz. Stelle sicher, dass alle Verbindungen sicher und korrekt sind.\n- **Schalter**: Installiere den Heizungsschalter an der gewünschten Stelle und verbinde ihn mit dem Heizungsgerät.\n\n### 5. Dichtungen und Abdichtungen\n- **Dichtungen**: Stelle sicher, dass alle Verbindungen und Öffnungen mit Dichtungen versehen sind, um Leckagen zu verhindern.\n- **Abdichtungen**: Installiere alle notwendigen Abdichtungen, um sicherzustellen, dass die Heizung sicher und effizient funktioniert. \n\n### 6. Test und Einstellung\n- **Test**: Schalte die Heizung ein und überprüfe, ob sie ordnungsgemäß funktioniert. Stelle sicher, dass die Temperatur korrekt eingestellt ist.\n- **Einstellung**: Justiere die Einstellungen des Heizungsgeräts, um die beste Leistung und Effizienz zu erzielen.\n\n### 7. Dokumentation und Wartung\n- **Dokumentation**: Dokumentiere alle Schritte und Änderungen, die während der Installation vorgenommen wurden.\n- **Wartung**: Plane regelmäßige Wartungen und Inspektionen, um die Lebensdauer und Effizienz der Heizung zu gewährleisten.\n\n### Wichtige Hinweise\n- **Sicherheitsvorkehrungen**: Achte immer auf die Sicherheitsvorkehrungen und folge den Anweisungen des Herstellers.\n- **Fachmann**: Lasse die Installation eines Heizungssystems, insbesondere bei komplexen Systemen, von einem Fachmann durchführen.\n\nIch hoffe, diese Anleitung hilft dir weiter. Wenn du spezifische Fragen hast oder weitere Details benötigst, lass es mich wissen!'
);
*/

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildPrompt(text: string, username: string): string {
  return `
    You are a helpful chatbot named Yasmin. 
    Use the informal form to address the user.
    Please answer the following request from the user named "${capitalize(username)}":

    ${text}

    Answer in the language used in this question: ${text}
  `;
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

function queryMistral(prompt: string): Promise<string> {
  const mistralBody = {
    model: 'ministral-3b-2410',
    messages: [
      {
        role: 'user',
        content: prompt
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
    .then(x => x.json())
    .then(mistralRes => {
      console.log(`INFO Received raw answer from mistral: ${JSON.stringify(mistralRes)}`);
      return (<MistralResponse>mistralRes).choices[0].message.content;
    });
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

app.post('/chat/slash', (req, res) => {
  const reqBody = <SynologyRequest>req.body;
  console.log(
    `INFO Slash Chat called - body : ${JSON.stringify(reqBody)} Headers: ${req.get('Content-Type')}`
  );
  if (reqBody.token != chatTokenSlash) {
    console.log('WARN Previous Slash chat request has invalid authorization token');
    res.sendStatus(401);
  } else {
    const question = reqBody.text.replace('/yasmin', '').trim();
    queryMistral(buildPrompt(question, reqBody.username)).then(answer =>
      res.status(200).send({
        text: formatMistralAnswer(answer)
      })
    );
  }
});

app.post('/chat/bot', (req, res) => {
  const reqBody = <SynologyRequest>req.body;
  console.log(`INFO Bot Chat called - body : ${JSON.stringify(reqBody)} Headers: ${req.get('Content-Type')}`);
  if (reqBody.token != chatTokenBot) {
    console.log('WARN Previous Bot Chat request has invalid authorization token');
    res.sendStatus(401);
  } else {
    queryMistral(buildPrompt(reqBody.text, reqBody.username)).then(answer => {
      const answers = splitter(formatMistralAnswer(answer));
      res.sendStatus(202);
      sendAnswersToChat(reqBody.user_id, answers);
    });
  }
});

app.get('/test', (req, res) => {
  res.status(200).send({ text: 'Test!' });
});

app.listen(5000, () => {
  console.log('Yasmin AI API Server started');
});
