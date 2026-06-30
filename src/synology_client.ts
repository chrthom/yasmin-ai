import { config } from './config';

export class SynologyClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
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
    if (str.length <= maxLength) return [str];

    const chunks: string[] = [];
    let pos = 0;

    while (pos < str.length) {
      const chunk = str.substring(pos, pos + maxLength);
      const lastNewline = chunk.lastIndexOf('\n');
      const actualEnd = lastNewline > 0 ? lastNewline : chunk.length;

      chunks.push(chunk.substring(0, actualEnd));
      pos += actualEnd + (str[pos + actualEnd] === '\n' ? 1 : 0);
    }

    return chunks;
  }

  async sendAnswersToChat(userId: number, answers: string[]): Promise<void> {
    const url = new URL(this.baseUrl);
    url.searchParams.append('api', 'SYNO.Chat.External');
    url.searchParams.append('method', 'chatbot');
    url.searchParams.append('version', '2');
    url.searchParams.append('token', this.token);

    // Process messages in reverse order (LIFO) to maintain existing behavior
    for (let i = answers.length - 1; i >= 0; i--) {
      const message = answers[i];
      if (!message) continue;

      try {
        const response = await fetch(url.toString(), {
          method: 'post',
          body: new URLSearchParams([['payload', JSON.stringify({ text: message, user_ids: [userId] })]]),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await response.json();
      } catch (error) {
        console.error(`ERROR Failed to send to Synology: ${error}`);
        throw error;
      }
    }
  }
}
