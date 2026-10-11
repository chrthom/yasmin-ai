import { config } from './config';

export interface SynologyPost {
  postId: number;
  userId: number;
  username: string;
  text: string;
  timestamp: number;
}

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

  formatChannelHistory(posts: SynologyPost[], botUserId: number, slashPrefix?: string): string {
    const prefix = slashPrefix ?? config.synology.history.slashPrefix;
    return posts
      .filter(post => post.userId !== botUserId && !post.text.trimStart().startsWith(prefix))
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(post => `${post.username}: ${post.text}`)
      .join('\n');
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
