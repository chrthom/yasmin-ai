import { contextService } from './services/context.service';
import { config } from './config';
import { dbProxy } from './database/db_proxy';
import {
  claimNoteDelivery,
  getUndeliveredNotesForUser,
  insertPendingNote,
  releaseNoteDelivery,
  PendingNoteForDelivery
} from './database/models/pending_notes.model';
import { buildHandoff, waitFor } from './handoff';

// The live agent is the only filter between sender and recipient (no nightly reviewer sits in
// between), so the share_note tool validates as strictly as stage_update does on the nightly side.
const NOTE_CONTENT_MAX_CHARS = 500;
const NOTE_TO_EVERYONE = 'everyone';

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
  turnCount: number;
}

export class ChatAgent {
  private url: string;
  private apiKey: string;
  private agentId: string;
  private conversationCache = new Map<string, CachedConversation>();
  private poisonedConversations = new Map<string, Set<string>>();
  private userQueues = new Map<string, Promise<unknown>>();
  // Handoff (summary + last turns) being prepared in the background for a conversation about to be replaced
  private pendingHandoffs = new Map<
    string,
    { conversationId: string; promise: Promise<string | undefined> }
  >();
  private conversationTtlMs = config.mistral.conversationTtlMs;
  private maxTurnsPerSession = config.mistral.maxTurnsPerSession;

  constructor(url: string, apiKey: string, agentId: string) {
    this.url = url;
    this.apiKey = apiKey;
    this.agentId = agentId;
  }

  private capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /**
   * Delivers undelivered pending notes to the given user, claiming each note's delivery
   * atomically right before it is used, so a concurrent duplicate input can never deliver
   * the same note to the same person twice (the lost UPDATE race returns false and the note
   * is skipped). Returns the formatted <nachrichten_fuer_dich> block plus the ids of the
   * notes it contains, or undefined if there is nothing to deliver. A failed outbox read
   * must not break the chat -- the notes simply stay pending and are delivered with the
   * next input.
   */
  private async deliverPendingNotes(
    username: string
  ): Promise<{ block: string; claimedIds: number[] } | undefined> {
    let notes: PendingNoteForDelivery[];
    try {
      notes = await getUndeliveredNotesForUser(username);
    } catch (error) {
      console.error(`ERROR Failed to load pending notes for ${username}: ${error}`);
      return undefined;
    }
    if (notes.length === 0) {
      return undefined;
    }
    const claimed: PendingNoteForDelivery[] = [];
    for (const note of notes) {
      try {
        if (await claimNoteDelivery(note.id, username)) {
          claimed.push(note);
        }
      } catch (error) {
        console.error(`ERROR Failed to claim delivery of note ${note.id} for ${username}: ${error}`);
      }
    }
    if (claimed.length === 0) {
      return undefined;
    }
    console.log(
      `INFO Delivering ${claimed.length} pending note(s) to ${username}: ` +
        claimed.map(n => `#${n.id} from ${n.fromUsername}`).join(', ')
    );
    const lines = claimed.map(
      note => `${this.capitalize(note.fromUsername)} wants me to tell you: ${note.content}`
    );
    return {
      block: `<nachrichten_fuer_dich>\n${lines.join('\n')}\n</nachrichten_fuer_dich>`,
      claimedIds: claimed.map(note => note.id)
    };
  }

  /**
   * Rolls back the delivery claims of the notes that were injected into a request which then
   * failed for a non-stale reason (HTTP 5xx, network error, or the tool request failing): the
   * notes were never actually shown to the user, so they become deliverable again with their
   * next input instead of being lost. A respawn (stale 404/400) reuses the claimed block and
   * must NOT release anything. Best-effort: a failed release is logged, not thrown.
   */
  private async releaseClaimedNotes(username: string, claimedIds: number[]): Promise<void> {
    for (const id of claimedIds) {
      try {
        await releaseNoteDelivery(id, username);
      } catch (error) {
        console.error(`ERROR Failed to release delivery claim of note ${id} for ${username}: ${error}`);
      }
    }
    if (claimedIds.length > 0) {
      console.log(
        `INFO Released ${claimedIds.length} undelivered pending note claim(s) for ${username}; they will be delivered with the next input`
      );
    }
  }

  /**
   * Executes the live agent's share_note tool: validates the recipient and content, then
   * writes the note to the pending_notes outbox. The note is delivered with the recipient's
   * next user input; the nightly pipeline consolidates anything still undelivered.
   */
  private async shareNote(username: string, to: unknown, content: unknown): Promise<string> {
    if (typeof to !== 'string' || to.length === 0) {
      return JSON.stringify({ success: false, error: 'Parameter "to" is required' });
    }
    const recipient = to === NOTE_TO_EVERYONE ? null : this.capitalize(to.trim());
    if (recipient !== null && !(await dbProxy.isKnownPerson(recipient))) {
      return JSON.stringify({
        success: false,
        error: `Unknown recipient "${to}". Use "everyone" or a known person's first name.`
      });
    }
    if (typeof content !== 'string' || content.trim().length === 0) {
      return JSON.stringify({ success: false, error: 'Content must be a non-empty message' });
    }
    if (content.length > NOTE_CONTENT_MAX_CHARS) {
      return JSON.stringify({
        success: false,
        error: `Content exceeds the ${NOTE_CONTENT_MAX_CHARS} character cap (${content.length} characters)`
      });
    }
    try {
      const id = await insertPendingNote(username, recipient, content.trim());
      console.log(`INFO Staged pending note #${id} from ${username} to ${recipient ?? 'everyone'}`);
      return JSON.stringify({
        success: true,
        id,
        to: recipient ?? 'everyone',
        delivery: "The note will be delivered with the recipient's next message."
      });
    } catch (error) {
      console.error(`ERROR Failed to store pending note from ${username}: ${error}`);
      return JSON.stringify({ success: false, error: 'Failed to store the note' });
    }
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

      const poisoned = this.poisonedConversations.get(username);
      const data = await response.json();
      const conversationId = (<MistralConversationMeta[]>data)
        .filter(
          c =>
            c.name == username &&
            c.agent_id == this.agentId &&
            Date.parse(c.updated_at) > Date.now() - this.conversationTtlMs &&
            !poisoned?.has(c.id)
        )
        .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
        .pop()?.id;

      // Cache the result if found, preserving any already loaded context titles and turn count
      if (conversationId) {
        const loadedTitles = cached ? cached.loadedContextTitles : [];
        const turnCount = cached ? cached.turnCount : 0;
        this.conversationCache.set(username, {
          conversationId,
          expiresAt: Date.now() + this.conversationTtlMs,
          loadedContextTitles: loadedTitles,
          turnCount
        });
        console.log(`DEBUG Cached conversation ${conversationId} for ${username}`);
      }

      return conversationId;
    } catch (error) {
      console.error(`ERROR Failed to get active conversation for ${username}: ${error}`);
      throw error;
    }
  }

  processRequest(
    userText: string,
    username: string,
    shortAnswer: boolean = false
  ): Promise<MistralConversationResponseOutput[]> {
    const previous = this.userQueues.get(username) || Promise.resolve();
    const run = previous.then(() => this.processRequestInternal(userText, username, shortAnswer, false));
    this.userQueues.set(
      username,
      run.catch(() => undefined)
    );
    return run;
  }

  private async processRequestInternal(
    userText: string,
    username: string,
    shortAnswer: boolean = false,
    isRespawn: boolean = false,
    handoffFrom?: string,
    // Notes already claimed (and therefore marked delivered) for this input. The respawn path
    // passes the block through: a respawn re-builds the prompt for the SAME input, so the notes
    // must ride along again -- getUndeliveredNotesForUser no longer returns them once claimed.
    claimedNotesBlock?: string,
    // Ids of the notes whose delivery was claimed for this input; released again when the
    // request fails for a non-stale reason (the notes were never shown to the user).
    claimedNoteIds: number[] = []
  ): Promise<MistralConversationResponseOutput[]> {
    try {
      let conversationId = await this.getActiveConversationId(username);
      console.log(`DEBUG Existing conversation ${conversationId}`);

      // Get or initialize cached conversation for this user
      let cached = this.conversationCache.get(username);
      if (!cached) {
        cached = {
          conversationId: conversationId || '',
          expiresAt: Date.now() + this.conversationTtlMs,
          loadedContextTitles: [],
          turnCount: 0
        };
        this.conversationCache.set(username, cached);
      }

      // Turn-based compaction: long conversations make every turn slower because Mistral
      // reprocesses the full history each time. Once the turn budget is exhausted, close the
      // current conversation (the nightly job still journals and deletes it later) and start a
      // fresh one so latency resets. A summary of the old conversation plus its last turns is
      // handed over in the new conversation's first prompt (see handoff.ts).
      if (conversationId && cached.turnCount >= this.maxTurnsPerSession) {
        console.log(
          `INFO Compacting session for ${username}: conversation ${conversationId} reached ` +
            `${cached.turnCount} turns (max ${this.maxTurnsPerSession}); starting a fresh conversation`
        );
        handoffFrom = conversationId;
        this.conversationCache.delete(username);
        conversationId = undefined;
        cached = {
          conversationId: '',
          expiresAt: Date.now() + this.conversationTtlMs,
          loadedContextTitles: [],
          turnCount: 0
        };
        this.conversationCache.set(username, cached);
      }

      // Query ContextService to find newly relevant context
      const { formattedContext, newlyLoadedTitles } = await contextService.getRelevantContext(
        userText,
        username,
        cached.loadedContextTitles
      );

      // A fresh conversation that replaces an earlier one starts with the handoff block
      const handoffBlock =
        !conversationId && handoffFrom ? await this.resolveHandoff(username, handoffFrom) : undefined;

      // Real-time outbox delivery: notes other people asked to pass to this user travel with
      // their next input, so a session that is already 20 turns old still receives them. On a
      // respawn the notes were already claimed for this input and are passed through instead
      // (claiming again would silently drop them -- see processRequestInternal's respawn paths).
      let notesBlock = claimedNotesBlock;
      if (!isRespawn) {
        const delivery = await this.deliverPendingNotes(username);
        if (delivery) {
          notesBlock = delivery.block;
          claimedNoteIds = delivery.claimedIds;
        }
      }
      // Prepend dynamic XML context (and handoff) to user text if present
      let promptContent = userText;
      if (handoffBlock) {
        promptContent = `${handoffBlock}\n\n${promptContent}`;
      }
      if (notesBlock) {
        promptContent = `${notesBlock}\n\n${promptContent}`;
      }
      if (formattedContext) {
        promptContent = `${formattedContext}\n\n${promptContent}`;
      }

      // Add short answer constraint if requested
      if (shortAnswer) {
        promptContent = `${promptContent}\n\nYour answer must be shorter than 1500 characters.`;
      }

      // Track newly loaded titles to avoid duplicates on future turns
      if (newlyLoadedTitles.length > 0) {
        cached.loadedContextTitles.push(...newlyLoadedTitles);
      }

      cached.turnCount++;

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
          if (conversationId) {
            this.markConversationPoisoned(username, conversationId);
          }
          this.conversationCache.delete(username);
          console.log(`INFO Cleared cached conversation for ${username} due to HTTP ${response.status}`);
        }
        // If we were resuming a cached conversation and it no longer exists (the nightly job deletes
        // consolidated conversations), respawn a fresh one once so the user's message isn't dropped.
        // isRespawn guards against looping if the freshly created conversation also fails.
        if (isStale && conversationId && !isRespawn) {
          console.log(`INFO Respawning a fresh conversation for ${username}`);
          return this.processRequestInternal(
            userText,
            username,
            shortAnswer,
            true,
            conversationId,
            notesBlock,
            claimedNoteIds
          );
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
        cached.turnCount = 1;
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

              // Entries already injected into this conversation are still in its history; return a
              // pointer instead of the full text to save tokens on every subsequent turn.
              const alreadyLoaded = cached.loadedContextTitles.includes(title);
              const content = alreadyLoaded ? null : await dbProxy.getContentByTitle(title);
              const resultStr = alreadyLoaded
                ? JSON.stringify({
                    title,
                    found: true,
                    already_in_context: true,
                    note: 'This entry is already in your context above; use that content.'
                  })
                : content
                  ? JSON.stringify({ title, content: content.trim(), found: true })
                  : JSON.stringify({ title, found: false, error: 'Context entry not found' });

              toolInputs.push({
                type: 'function.result',
                tool_call_id: call.id,
                result: resultStr
              });
            } else if (call.name === 'share_note') {
              let args: any = {};
              try {
                args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
              } catch (e) {
                console.error(`ERROR Failed to parse share_note arguments: ${e}`);
              }
              console.log(`INFO Tool execution: share_note to "${String(args.to)}" for ${username}`);
              const resultStr = await this.shareNote(username, args.to, args.content);
              toolInputs.push({
                type: 'function.result',
                tool_call_id: call.id,
                result: resultStr
              });
            } else {
              // Unknown tool (e.g. a stray update_context_entry call from a not-yet-reconfigured
              // Mistral Console agent): answer the call so the conversation cannot stall, but
              // never execute it.
              console.warn(`WARNING Ignoring unsupported tool call "${call.name}"`);
              toolInputs.push({
                type: 'function.result',
                tool_call_id: call.id,
                result: JSON.stringify({
                  success: false,
                  error: `Unsupported tool: ${call.name}`
                })
              });
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
              // A failed tool-result request can leave the conversation in a broken state (pending
              // function call) that rejects all further turns with HTTP 400. Poison it so it is never
              // re-selected, and respawn the user's message once in a fresh conversation.
              this.markConversationPoisoned(username, currentConversationId);
              this.conversationCache.delete(username);
              console.log(
                `INFO Cleared cached conversation for ${username} due to tool request HTTP ${toolResponse.status}`
              );
              if (!isRespawn) {
                console.log(`INFO Respawning a fresh conversation for ${username}`);
                return this.processRequestInternal(
                  userText,
                  username,
                  shortAnswer,
                  true,
                  currentConversationId,
                  notesBlock,
                  claimedNoteIds
                );
              }
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

      this.scheduleHandoff(username, cached);
      return responseOutputs;
    } catch (error) {
      // A non-stale failure (HTTP 5xx, network error, failed tool request without respawn)
      // means the notes injected above were never shown to the user. Release their delivery
      // claims so they are delivered with the next input instead of being lost. On the respawn
      // paths the recursive call owns the claims from here on -- releasing would race it.
      if (!isRespawn && claimedNoteIds.length > 0) {
        await this.releaseClaimedNotes(username, claimedNoteIds);
      }
      console.error(`ERROR Failed to process request for ${username}: ${error}`);
      throw error;
    }
  }

  // Once the turn that exhausts the budget is answered, prepare the handoff in the background so the next
  // turn (which starts the fresh conversation) does not have to wait for the summary.
  private scheduleHandoff(username: string, cached: CachedConversation): void {
    if (!cached.conversationId || cached.turnCount < this.maxTurnsPerSession) {
      return;
    }
    if (this.pendingHandoffs.get(username)?.conversationId === cached.conversationId) {
      return;
    }
    this.pendingHandoffs.set(username, {
      conversationId: cached.conversationId,
      promise: buildHandoff(cached.conversationId)
    });
  }

  // Waits (bounded) for the background summary; if it is not ready, goes with the last turns only.
  private async resolveHandoff(username: string, fromConversationId: string): Promise<string | undefined> {
    const pending = this.pendingHandoffs.get(username);
    this.pendingHandoffs.delete(username);
    const promise =
      pending?.conversationId === fromConversationId ? pending.promise : buildHandoff(fromConversationId);
    const block = await waitFor(promise, config.mistral.handoffWaitMs);
    return block ?? (await buildHandoff(fromConversationId, { withSummary: false }));
  }

  private markConversationPoisoned(username: string, conversationId: string): void {
    let poisoned = this.poisonedConversations.get(username);
    if (!poisoned) {
      poisoned = new Set<string>();
      this.poisonedConversations.set(username, poisoned);
    }
    poisoned.add(conversationId);
    console.log(`INFO Marked conversation ${conversationId} as poisoned for ${username}`);
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
