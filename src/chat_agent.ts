import { contextService } from './services/context.service';
import { config } from './config';
import { dbProxy } from './database/db_proxy';

interface MistralConversationResponseOutputPart {
  type: string;
  text: string;
}

interface MistralToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string | object;
  };
}

interface MistralConversationResponseOutput {
  content: string | MistralConversationResponseOutputPart[];
  type: string;
  tool_calls?: MistralToolCall[];
}

interface MistralConversationResponse {
  id?: string;
  conversation_id?: string;
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
    shortAnswer: boolean = false,
    isRespawn: boolean = false
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

      // Add short answer constraint if requested
      if (shortAnswer) {
        promptContent = `${promptContent}\n\nYour answer must be shorter than 1500 characters.`;
      }

      // Keep tool usage within the model's completion token budget: batch-rewriting many long
      // context entries in a single turn exhausts the budget during reasoning, so the turn ends
      // with no text part at all.
      promptContent = `${promptContent}\n\nWhen updating context entries: update at most two entries per turn and keep each entry's content concise. Do not plan or draft full entry contents in your visible reasoning; emit tool calls directly.`;

      // Track newly loaded titles to avoid duplicates on future turns
      if (newlyLoadedTitles.length > 0) {
        cached.loadedContextTitles.push(...newlyLoadedTitles);
      }

      const body: any = {
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
        const isStale = response.status === 400 || response.status === 404;
        if (isStale) {
          this.conversationCache.delete(username);
          console.log(`INFO Cleared cached conversation for ${username} due to HTTP ${response.status}`);
        }
        // If we were resuming a cached conversation and it no longer exists (the nightly job deletes
        // consolidated conversations), respawn a fresh one once so the user's message isn't dropped.
        // isRespawn guards against looping if the freshly created conversation also fails.
        if (isStale && conversationId && !isRespawn) {
          console.log(`INFO Respawning a fresh conversation for ${username}`);
          return this.processRequest(userText, username, shortAnswer, true);
        }
        throw new Error(`Mistral API request failed: HTTP ${response.status}`);
      }

      const data = <MistralConversationResponse>await response.json();
      console.log(`DEBUG Received raw answer from mistral: ${JSON.stringify(data)}`);

      const returnedId = data.conversation_id || data.id;
      // Cache the new conversation ID so next turn skips the list re-fetch
      if (!conversationId && returnedId) {
        cached.conversationId = returnedId;
        cached.expiresAt = Date.now() + this.conversationTtlMs;
        console.log(`DEBUG Cached new conversation ${returnedId} for ${username}`);
      }

      let responseOutputs = data.outputs;
      let toolCallDetected = true;
      let loopCount = 0;
      const maxToolCalls = 5;

      while (toolCallDetected && loopCount < maxToolCalls) {
        const toolCalls: Array<{ id: string; name: string; arguments: any }> = [];

        for (const o of responseOutputs) {
          if (o.type === 'message.tool_calls' && o.tool_calls) {
            for (const tc of o.tool_calls) {
              toolCalls.push({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments
              });
            }
          } else if (o.type === 'function.call' || o.type === 'function_call') {
            const flatCall = o as any;
            toolCalls.push({
              id: flatCall.tool_call_id || flatCall.id,
              name: flatCall.name,
              arguments: flatCall.arguments
            });
          }
        }

        if (toolCalls.length > 0) {
          loopCount++;
          console.log(`INFO Tool call(s) detected: ${JSON.stringify(toolCalls)}`);

          const toolInputs: any[] = [];

          for (const call of toolCalls) {
            if (call.name === 'read_context_entry') {
              let args: any = {};
              try {
                args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
              } catch (e) {
                console.error(`ERROR Failed to parse tool arguments: ${e}`);
              }

              const title = args.title;
              if (!title) {
                console.warn('WARNING Tool execution: read_context_entry called with empty/missing title');
                toolInputs.push({
                  type: 'function.result',
                  tool_call_id: call.id,
                  result: JSON.stringify({ found: false, error: 'Title parameter is required' })
                });
                continue;
              }
              console.log(`INFO Tool execution: read_context_entry for title "${title}"`);

              const content = await dbProxy.getContentByTitle(title);
              const resultStr = content
                ? JSON.stringify({ title, content: content.trim(), found: true })
                : JSON.stringify({ title, found: false, error: 'Context entry not found' });

              toolInputs.push({
                type: 'function.result',
                tool_call_id: call.id,
                result: resultStr
              });
            }
            if (call.name === 'update_context_entry') {
              let args: any = {};
              try {
                args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
              } catch (e) {
                console.error(`ERROR Failed to parse tool arguments: ${e}`);
              }

              const title = args.title;
              const content = args.content;
              if (!title) {
                console.warn('WARNING Tool execution: update_context_entry called with empty/missing title');
                toolInputs.push({
                  type: 'function.result',
                  tool_call_id: call.id,
                  result: JSON.stringify({ success: false, error: 'Title parameter is required' })
                });
                continue;
              }
              if (!content) {
                console.warn(
                  'WARNING Tool execution: update_context_entry called with empty/missing content'
                );
                toolInputs.push({
                  type: 'function.result',
                  tool_call_id: call.id,
                  result: JSON.stringify({ success: false, error: 'Content parameter is required' })
                });
                continue;
              }
              console.log(`INFO Tool execution: update_context_entry for title "${title}"`);

              try {
                await dbProxy.updateEntry(title, content);
                toolInputs.push({
                  type: 'function.result',
                  tool_call_id: call.id,
                  result: JSON.stringify({ success: true, title, content: content.trim() })
                });
              } catch (err) {
                console.error(
                  `ERROR Tool execution: update_context_entry failed for title "${title}": ${err}`
                );
                toolInputs.push({
                  type: 'function.result',
                  tool_call_id: call.id,
                  result: JSON.stringify({ success: false, title, error: 'Failed to update context entry' })
                });
              }
            }
          }

          if (toolInputs.length > 0) {
            const currentConversationId = cached.conversationId || conversationId;
            if (!currentConversationId) {
              console.error('ERROR Tool call received but no conversation ID is available!');
              throw new Error('No conversation ID available for tool response');
            }

            const toolBody = {
              inputs: toolInputs
            };
            const toolUrl = `${this.url}/${currentConversationId}`;

            console.log(`INFO Sending tool results to Mistral: ${JSON.stringify(toolBody)}`);
            const toolResponse = await fetch(toolUrl, {
              method: 'post',
              body: JSON.stringify(toolBody),
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`
              }
            });

            if (!toolResponse.ok) {
              console.error(
                `ERROR Mistral API request for tool failed: HTTP ${toolResponse.status} ${toolResponse.statusText}`
              );
              throw new Error(`Mistral API request for tool failed: HTTP ${toolResponse.status}`);
            }

            const toolData = <MistralConversationResponse>await toolResponse.json();
            console.log(`DEBUG Received raw answer after tool execution: ${JSON.stringify(toolData)}`);

            responseOutputs = toolData.outputs;
          } else {
            toolCallDetected = false;
          }
        } else {
          toolCallDetected = false;
        }
      }

      return responseOutputs;
    } catch (error) {
      console.error(`ERROR Failed to process request for ${username}: ${error}`);
      throw error;
    }
  }

  convertMultiPart(outputs: MistralConversationResponseOutput[]): string {
    const messageOutputs = outputs.filter(o => o.type == 'message.output');
    if (messageOutputs.length === 0) {
      console.log('WARN No output of type message.output was found!');
      return '';
    }

    const texts: string[] = [];
    for (const messageOutput of messageOutputs) {
      if (typeof messageOutput.content === 'string') {
        texts.push(messageOutput.content);
      } else {
        texts.push(
          ...(<MistralConversationResponseOutputPart[]>messageOutput.content)
            .filter(p => p.type == 'text')
            .map(p => p.text)
        );
      }
    }

    const text = texts.join(' ').trim();
    if (!text) {
      console.log('WARN No text part found in message.output entries!');
    }
    return text;
  }
}
