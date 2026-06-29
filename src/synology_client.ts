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
    const chunks: string[] = [];
    let remaining = str;

    while (remaining.length > 0) {
      let chunkEnd = Math.min(maxLength, remaining.length);
      // Try to break at newline if possible
      const lastNewline = remaining.lastIndexOf('\n', chunkEnd);
      if (lastNewline > 0) chunkEnd = lastNewline;

      chunks.push(remaining.substring(0, chunkEnd));
      remaining = remaining.substring(chunkEnd + (remaining[chunkEnd] === '\n' ? 1 : 0));
    }
    return chunks;
  }

  async sendAnswersToChat(userId: number, answers: string[]): Promise<void> {
    const answersCopy = [...answers];
    const url = new URL(this.baseUrl);
    url.searchParams.append('api', 'SYNO.Chat.External');
    url.searchParams.append('method', 'chatbot');
    url.searchParams.append('version', '2');
    url.searchParams.append('token', this.token);

    while (answersCopy.length > 0) {
      const message = answersCopy.pop();
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
