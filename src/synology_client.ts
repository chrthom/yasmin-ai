import { config } from './config';

export class SynologyClient {
  private url: string;
  private token: string;

  constructor(incomingURL: string, token: string) {
    this.url = incomingURL;
    this.token = token;
  }

  formatAnswer(answer: string): string {
    return answer
      .toString()
      .replaceAll(/\*\*?([^*]+)\*\*?/gm, '$1')
      .replaceAll(/^#+(.*)$/gm, '$1')
      .trim();
  }

  chunkText(str: string, maxLength: number = config.chunk.maxLength): string[] {
    const chunks: string[] = [];
    while (str.length > 0) {
      // Find the last newline before maxLength
      let chunkEnd = str.lastIndexOf('\n', maxLength);
      if (chunkEnd === -1) chunkEnd = maxLength;
      chunks.push(str.substring(0, chunkEnd));
      // Skip past the newline we found (or use chunkEnd if no newline)
      const nextPos = chunkEnd < str.length && str[chunkEnd] === '\n' ? chunkEnd + 1 : chunkEnd;
      str = str.substring(nextPos);
    }
    return chunks;
  }

  async sendAnswersToChat(userId: number, answers: string[]): Promise<void> {
    while (answers.length > 0) {
      const message = answers.pop();
      if (message) {
        console.log(`DEBUG Send message to synology - ${answers.length} parts remaining`);
        try {
          const response = await fetch(`${this.url}%22${this.token}%22`, {
            method: 'post',
            body: new URLSearchParams([
              ['payload', JSON.stringify({ text: message, user_ids: [userId] })]
            ]),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
          });

          if (!response.ok) {
            console.error(`ERROR Failed to send message to Synology: HTTP ${response.status} ${response.statusText}`);
            throw new Error(`Synology API request failed: HTTP ${response.status}`);
          }

          await response.json(); // Ensure we consume the response body
        } catch (error) {
          console.error(`ERROR Failed to send message to Synology: ${error}`);
          throw error;
        }
      }
    }
  }
}
