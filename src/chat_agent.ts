import { contextService } from './services/context.service';
import { config } from './config';

interface MistralConversationResponseOutputPart {
  type: string;
  text: string;
}

interface MistralConversationResponseOutput {
  content: string | MistralConversationResponseOutputPart[];
  type: string;
}

interface MistralConversationResponse {
  outputs: MistralConversationResponseOutput[];
}

interface MistralConversationMeta {
  name: string;
  id: string;
  updated_at: string;
  agent_id: string;
}

interface CachedConversation {
  conversationId: string;
  expiresAt: number;
  loadedContextTitles: string[];
}

export class ChatAgent {
  private url: string;
  private apiKey: string;
  private agentId: string;
  private conversationCache = new Map<string, CachedConversation>();
  private conversationTtlMs = config.mistral.conversationTtlMs;

  constructor(url: string, apiKey: string, agentId: string) {
    this.url = url;
    this.apiKey = apiKey;
    this.agentId = agentId;
  }

  private capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  private async getActiveConversationId(username: string): Promise<string | undefined> {
    // Check cache first
    const cached = this.conversationCache.get(username);
    if (cached && cached.expiresAt > Date.now() && cached.conversationId) {
      console.log(`DEBUG Cached conversation ${cached.conversationId} for ${username}`);
      return cached.conversationId;
    }

    try {
      const response = await fetch(this.url, {
        method: 'get',
        headers: {
          Authorization: `Bearer ${this.apiKey}`
        }
      });

      if (!response.ok) {
        console.error(
          `ERROR Failed to fetch conversations for ${username}: HTTP ${response.status} ${response.statusText}`
        );
        throw new Error(`Failed to fetch conversations: HTTP ${response.status}`);
      }

      const data = await response.json();
      const conversationId = (<MistralConversationMeta[]>data)
        .filter(
          c =>
            c.name == username &&
            c.agent_id == this.agentId &&
            Date.parse(c.updated_at) > Date.now() - this.conversationTtlMs
        )
        .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
        .pop()?.id;

      // Cache the result if found, preserving any already loaded context titles
      if (conversationId) {
        const loadedTitles = cached ? cached.loadedContextTitles : [];
        this.conversationCache.set(username, {
          conversationId,
          expiresAt: Date.now() + this.conversationTtlMs,
          loadedContextTitles: loadedTitles
        });
        console.log(`DEBUG Cached conversation ${conversationId} for ${username}`);
      }

      return conversationId;
    } catch (error) {
      console.error(`ERROR Failed to get active conversation for ${username}: ${error}`);
      throw error;
    }
  }

  async processRequest(
    userText: string,
    username: string,
    shortAnswer: boolean = false
  ): Promise<MistralConversationResponseOutput[]> {
    try {
      const conversationId = await this.getActiveConversationId(username);
      console.log(`DEBUG Existing conversation ${conversationId}`);

      // Get or initialize cached conversation for this user
      let cached = this.conversationCache.get(username);
      if (!cached) {
        cached = {
          conversationId: conversationId || '',
          expiresAt: Date.now() + this.conversationTtlMs,
          loadedContextTitles: []
        };
        this.conversationCache.set(username, cached);
      }

      // Query ContextService to find newly relevant context
      const { formattedContext, newlyLoadedTitles } = await contextService.getRelevantContext(
        userText,
        username,
        cached.loadedContextTitles
      );

      // Prepend dynamic XML context to user text if present
      let promptContent = userText;
      if (formattedContext) {
        promptContent = `${formattedContext}\n\n${userText}`;
      }

      // Add short answer constraint on initial prompt if requested
      if (!conversationId && shortAnswer) {
        promptContent = `${promptContent}\n\nYour answer must be shorter than 1500 characters.`;
      }

      // Track newly loaded titles to avoid duplicates on future turns
      if (newlyLoadedTitles.length > 0) {
        cached.loadedContextTitles.push(...newlyLoadedTitles);
      }

      const body = {
        agent_id: conversationId ? undefined : this.agentId,
        name: conversationId ? undefined : username,
        inputs: [
          {
            role: 'user',
            content: promptContent
          }
        ]
      };
      console.log(`INFO Sending prompt to LLM agent: ${JSON.stringify(body)}`);

      const url = conversationId ? `${this.url}/${conversationId}` : this.url;
      const response = await fetch(url, {
        method: 'post',
        body: JSON.stringify(body),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        }
      });

      if (!response.ok) {
        console.error(`ERROR Mistral API request failed: HTTP ${response.status} ${response.statusText}`);
        throw new Error(`Mistral API request failed: HTTP ${response.status}`);
      }

      const data = await response.json();
      console.log(`DEBUG Received raw answer from mistral: ${JSON.stringify(data)}`);
      return (<MistralConversationResponse>data).outputs;
    } catch (error) {
      console.error(`ERROR Failed to process request for ${username}: ${error}`);
      throw error;
    }
  }

  convertMultiPart(outputs: MistralConversationResponseOutput[]): string {
    const messageOutput = outputs.find(o => o.type == 'message.output');
    if (!messageOutput) {
      console.log('WARN No output of type message.output was found!');
      return '';
    }
    if (typeof messageOutput.content === 'string') {
      return messageOutput.content;
    } else {
      return (<MistralConversationResponseOutputPart[]>messageOutput.content)
        .filter(p => p.type == 'text')
        .map(p => p.text)
        .join(' ');
    }
  }
}
