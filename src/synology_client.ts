export class SynologyClient {
  private url: string;
  private token: string;

  constructor(incomingURL: string, token: string) {
    this.url = incomingURL;
    this.token = token;
  }

  formatAnswer(answer: string): string {
    return answer.toString().trim();
  }

  chunkText(str: string, l: number = 1800) {
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

  async sendAnswersToChat(userId: number, answers: string[]) {
    if (answers.length) {
      const message = answers.pop();
      console.log(`DEBUG Send message to synology - ${answers.length} parts remaining`);
      fetch(`${this.url}%22${this.token}%22`, {
        method: 'post',
        body: new URLSearchParams([
          [
            'payload',
            JSON.stringify({
              text: message,
              user_ids: [userId]
            })
          ]
        ]),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }).then(() => this.sendAnswersToChat(userId, answers));
    }
  }
}
