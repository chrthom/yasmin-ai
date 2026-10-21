import { config } from './config';

/**
 * A single post of a Synology Chat channel, as returned by the external `post_list` API.
 */
export interface SynologyPost {
  postId: number;
  userId: number;
  username: string;
  text: string;
  timestamp: number;
}

/**
 * Delivers answers to Synology Chat via its webhook API: strips the Markdown formatting the
 * chat cannot render, chunks messages that exceed its length limit, and posts each chunk to
 * the requesting user in reading order.
 */
export class SynologyClient {
  private baseUrl: string;
  private token: string;

  /**
   * Stores the incoming webhook URL and the endpoint's authentication token.
   *
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
   * Fetches the messages posted in a channel immediately before the given post via Synology
   * Chat's external `post_list` API.
   *
   * @param channelId The channel to read.
   * @param postId The post the history is relative to (everything before it is returned).
   * @param prevCount How many previous posts to fetch (config.synology.history.prevCount).
   * @param token The token to authenticate the API call (the channel's token by default).
   * @returns The fetched posts, in the order the API returned them.
   * @throws When the HTTP call fails, the API reports an error, or the response is malformed.
   */
  async fetchPreviousMessages(
    channelId: number,
    postId: number,
    prevCount: number,
    token: string = this.token
  ): Promise<SynologyPost[]> {
    const url = new URL(this.baseUrl);
    url.searchParams.append('api', 'SYNO.Chat.External');
    url.searchParams.append('method', 'post_list');
    url.searchParams.append('version', '2');
    const response = await fetch(url.toString(), {
      method: 'post',
      body: new URLSearchParams([
        [
          'payload',
          JSON.stringify({
            token,
            channel_id: channelId,
            post_id: postId,
            prev_count: prevCount,
            next_count: 0
          })
        ]
      ]),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(config.synology.history.fetchTimeoutMs)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: any = await response.json();
    if (!data?.success) {
      throw new Error(data?.error?.errors?.[0] || 'post_list request was not successful');
    }
    const rawPosts = data?.data?.posts || [];
    const posts: Record<string, unknown>[] = Array.isArray(rawPosts)
      ? rawPosts
      : typeof rawPosts === 'object'
        ? Object.keys(rawPosts).map(key => ({ ...rawPosts[key], post_id: Number(key) }))
        : [];
    return posts.map(post => ({
      postId: Number(post['post_id']),
      userId: Number(post['user_id']),
      username: String(post['username'] || ''),
      text: String(post['text'] || ''),
      timestamp: Number(post['timestamp']) || 0
    }));
  }

  /**
   * Formats fetched channel posts as a transcript: the bot's own posts and slash-command
   * invocations are dropped, the rest are ordered oldest-first as `username: text` lines.
   *
   * @param posts The fetched channel posts.
   * @param botUserId The bot's own user id, whose posts are excluded from the transcript.
   * @param slashPrefix The prefix that marks slash-command posts (defaults to config).
   * @returns The transcript lines joined by newlines; empty when nothing remains.
   */
  formatChannelHistory(posts: SynologyPost[], botUserId: number, slashPrefix?: string): string {
    const prefix = slashPrefix ?? config.synology.history.slashPrefix;
    return posts
      .filter(post => post.userId !== botUserId && !post.text.trimStart().startsWith(prefix))
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(post => `${post.username}: ${post.text}`)
      .join('\n');
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
