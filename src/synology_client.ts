import { config } from './config';

/**
 * Delivers answers to Synology Chat via its webhook API: strips the Markdown formatting the
 * chat cannot render, chunks messages that exceed its length limit, and posts each chunk to
 * the requesting user in reading order.
 */
export class SynologyClient {
  private baseUrl: string;
  private token: string;

  /**
   * @param baseUrl Synology Chat incoming webhook URL (config.synology.chatIncomingUrl).
   * @param token The endpoint's authentication token (the bot token by convention).
   */
  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  /**
   * Formats an answer for display in Synology Chat: strips bold markers and heading hashes that
   * the chat cannot render, and trims surrounding whitespace.
   *
   * @param answer The raw LLM answer text.
   * @returns The plain-text answer ready to display.
   */
  formatAnswer(answer: string): string {
    return answer
      .toString()
      .replaceAll(/\*\*?([^*]+)\*\*?/gm, '$1')
      .replaceAll(/^#+(.*)$/gm, '$1')
      .trim();
  }

  /**
   * Splits a long text into chunks of at most maxLength characters, preferring to break at
   * newlines so paragraphs stay intact.
   *
   * @param str The text to chunk.
   * @param maxLength Maximum characters per chunk (defaults to config.chunk.maxLength).
   * @returns The chunks, in original reading order.
   */
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

  /**
   * Posts the given answer chunks to the requesting user's Synology Chat.
   *
   * @param userId The Synology Chat user id to deliver to.
   * @param answers The already-chunked message texts, in send order (empty chunks are skipped).
   * @throws Error when any request fails or the API answers with a non-OK status.
   */
  async sendAnswersToChat(userId: number, answers: string[]): Promise<void> {
    const url = new URL(this.baseUrl);
    url.searchParams.append('api', 'SYNO.Chat.External');
    url.searchParams.append('method', 'chatbot');
    url.searchParams.append('version', '2');
    url.searchParams.append('token', this.token);

    // Synology Chat shows messages in send order, so deliver chunks in natural
    // order (first chunk first) to keep the answer readable top-down.
    for (const message of answers) {
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
