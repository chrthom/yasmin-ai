import { z } from 'zod';
import { config } from '../config';
import { extractContentText } from './content';

// ---------------------------------------------------------------------------
// Errors + retry
// ---------------------------------------------------------------------------

/** Error carrying the HTTP status of a failed Mistral API call, so retry/respawn logic can branch on it. */
export class MistralApiError extends Error {
  public readonly status?: number;

  /**
   * Builds the error, preserving the failed response's HTTP status for retry/respawn branching.
   *
   * @param message The error message.
   * @param status The HTTP status of the failed response, when the call got that far.
   */
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'MistralApiError';
    this.status = status;
  }
}

/** Tuning for withRetry's exponential backoff; safeRetry restricts retries to provably uncommitted typed errors. */
export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  jitter?: boolean;
  /**
   * Only retry typed MistralApiErrors with a retryable HTTP status (429/5xx). Such a response proves
   * the server rejected the request without processing it, so a re-POST cannot duplicate anything.
   * Network-style errors (timeouts, socket failures) stay non-retryable because the request may have
   * been committed; used for non-idempotent POSTs like creating/appending to a conversation.
   */
  safeRetry?: boolean;
}

/** Resolves after the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Hard ceiling for any single Mistral HTTP call. withRetry only engages on a *thrown* error,
// so without this a hung TCP/TLS connection would never settle and would block a phase
// indefinitely while holding processing_lock.
const REQUEST_TIMEOUT_MS = config.mistral.requestTimeoutMs;

/**
 * Canonical URL of the conversations endpoint, derived from the single configured API root so
 * the host exists in exactly one place (config.mistral.apiRoot).
 */
export function conversationsUrl(): string {
  return config.mistral.apiRoot + '/conversations';
}

/**
 * fetch with a hard timeout (AbortController). On timeout the request is aborted and a plain Error
 * is thrown -- a network-style failure that withRetry treats as retryable, unlike a typed 4xx.
 * `timeoutMs` lets callers override the default REQUEST_TIMEOUT_MS ceiling.
 *
 * @param url The URL to fetch.
 * @param init Standard fetch init (method, headers, body).
 * @param timeoutMs Hard timeout in milliseconds for this single call.
 * @returns The fetch response.
 * @throws Error when the request is aborted by the timeout; rethrows any other fetch error.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('Mistral API request timed out after ' + timeoutMs + 'ms: ' + url);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs fn with exponential-backoff retry on network errors and 429/5xx MistralApiErrors; other 4xx fail fast.
 *
 * @param fn The operation to (re)attempt.
 * @param opts Retry tuning; safeRetry restricts retries to typed, provably uncommitted HTTP errors.
 * @returns The value fn resolves with.
 * @throws The last error when it is not retryable or the retry budget is exhausted.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const retries = opts?.retries ?? config.nightly.maxRetries;
  const baseMs = opts?.baseMs ?? 500;
  const useJitter = opts?.jitter !== false;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      const isApiError = error instanceof MistralApiError;
      const status = isApiError ? error.status : undefined;
      const retryableStatus = status === 429 || (typeof status === 'number' && status >= 500);
      const retryable = opts?.safeRetry ? isApiError && retryableStatus : !isApiError || retryableStatus;

      if (!retryable || attempt >= retries) {
        throw error;
      }

      const delay = baseMs * Math.pow(2, attempt) + (useJitter ? Math.random() * baseMs : 0);
      console.warn(
        'WARN Mistral API call failed (attempt ' +
          (attempt + 1) +
          '/' +
          (retries + 1) +
          '), retrying in ' +
          Math.round(delay) +
          'ms: ' +
          error
      );
      await sleep(delay);
      attempt++;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal request helpers
// ---------------------------------------------------------------------------

/**
 * Performs a GET/POST JSON request against the Mistral API and validates the response with schema
 *
 * @param method The HTTP method to use.
 * @param path The API path (relative to config.mistral.apiRoot).
 * @param schema Zod schema the response body must satisfy.
 * @param body Optional JSON request body.
 * @param opts Retry options.
 * @returns The schema-validated response.
 * @throws MistralApiError on a non-OK status; rethrows schema/network errors after retries.
 */
async function requestJson<T>(
  method: 'GET' | 'POST',
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  opts?: RetryOptions
): Promise<T> {
  return withRetry(async () => {
    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + config.mistral.apiKey
    };

    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await fetchWithTimeout(config.mistral.apiRoot + path, init);

    if (!response.ok) {
      console.error('ERROR Mistral API request failed: HTTP ' + response.status + ' ' + method + ' ' + path);
      throw new MistralApiError('Mistral API request failed: HTTP ' + response.status, response.status);
    }

    const data = await response.json();
    return schema.parse(data);
  }, opts);
}

/**
 * Performs an idempotent DELETE against the Mistral API; treats 204 and 404 as success
 *
 * @param path The API path (relative to config.mistral.apiRoot).
 * @param opts Retry options.
 * @throws MistralApiError on any status other than 204/404/2xx.
 */
async function requestDelete(path: string, opts?: RetryOptions): Promise<void> {
  await withRetry(async () => {
    const response = await fetchWithTimeout(config.mistral.apiRoot + path, {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer ' + config.mistral.apiKey
      }
    });

    if (response.status === 204 || response.status === 404) {
      return;
    }

    if (!response.ok) {
      console.error('ERROR Mistral API delete failed: HTTP ' + response.status + ' ' + path);
      throw new MistralApiError(
        'Mistral API delete request failed: HTTP ' + response.status,
        response.status
      );
    }
  }, opts);
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/** Metadata of one Mistral conversation, as returned by the list endpoint. */
export interface ConversationMeta {
  id: string;
  name?: string | null;
  agentId?: string;
  updatedAt: string;
}

const ConversationMetaResponseSchema = z.object({
  id: z.string(),
  // Mistral returns `name: null` for conversations that were created without a name, which Zod's
  // `.optional()` would reject (it only accepts `undefined`). `.nullish()` permits both `null` and
  // `undefined` so a nameless conversation doesn't abort paginated listing.
  name: z.string().nullish(),
  agent_id: z.string().optional(),
  updated_at: z.string()
});

const ConversationListResponseSchema = z.array(ConversationMetaResponseSchema);

/**
 * Lists conversations updated at or after sinceIso.
 *
 * GET /v1/conversations is offset-paginated via `page` (default 0) / `page_size` (default 100) and
 * returns a bare array with no pagination envelope, so the last page is detected when a page has
 * fewer items than `page_size`. Because there is no ordering guarantee, we must fetch every page
 * before applying the client-side updated_at filter -- otherwise conversations beyond the first
 * _page_size_ would be silently dropped and their memory missed.
 *
 * @param sinceIso ISO timestamp; only conversations updated at or after it are returned.
 * @returns All conversations (any agent) updated since the watermark; pagination stops once a
 *   page adds no new ids.
 */
export async function listConversations(sinceIso: string): Promise<ConversationMeta[]> {
  const CONVERSATION_PAGE_SIZE = 100;
  const sinceMs = Date.parse(sinceIso);
  const seenIds = new Set<string>();
  const all: ConversationMeta[] = [];
  let page = 0;

  for (;;) {
    const path = '/conversations?page=' + page + '&page_size=' + CONVERSATION_PAGE_SIZE;
    const data = await requestJson('GET', path, ConversationListResponseSchema);

    let added = 0;
    for (const c of data) {
      if (!seenIds.has(c.id)) {
        seenIds.add(c.id);
        added++;
      }
      all.push({
        id: c.id,
        name: c.name,
        agentId: c.agent_id,
        updatedAt: c.updated_at
      });
    }

    // No-progress guard: a server that ignores "page=" and keeps re-serving the same full list would
    // otherwise loop forever. Stop once a page adds zero NEW conversations.
    if (data.length >= CONVERSATION_PAGE_SIZE && added === 0) {
      console.error(
        'ERROR listConversations server returned no new conversations; stopping pagination early'
      );
      break;
    }

    // A short page signals the last page.
    if (data.length < CONVERSATION_PAGE_SIZE) {
      break;
    }

    page++;
  }

  return all.filter(c => Date.parse(c.updatedAt) >= sinceMs);
}

/** One raw message row of a conversation's history, of any type (dialogue, tool call, result, ...). */
export interface ConversationMessage {
  id?: string;
  type: string;
  role?: string;
  content?: unknown;
  createdAt?: string;
}

const ConversationMessageResponseSchema = z.object({
  id: z.string().optional(),
  type: z.string(),
  role: z.string().optional(),
  content: z.unknown().optional(),
  created_at: z.string().optional()
});

// GET /v1/conversations/{id}/messages returns an ENVELOPED object (`{ conversation_id, messages: [...],
// object }`), not a bare array -- see Mistral's conversations endpoint docs. We accept the documented
// enveloped shape, with a bare-array fallback so a shape change doesn't hard-fail the collect phase.
const ConversationMessageListResponseSchema = z.union([
  z.object({ messages: z.array(ConversationMessageResponseSchema) }).passthrough(),
  z.array(ConversationMessageResponseSchema)
]);

/**
 * Fetches the full message history for a conversation
 *
 * @param conversationId The conversation to read.
 * @returns The conversation's raw messages, oldest first.
 */
export async function getConversationMessages(conversationId: string): Promise<ConversationMessage[]> {
  const data = await requestJson(
    'GET',
    '/conversations/' + conversationId + '/messages',
    ConversationMessageListResponseSchema
  );

  const rows = Array.isArray(data) ? data : data.messages;
  return rows.map(m => ({
    id: m.id,
    type: m.type,
    role: m.role,
    content: m.content,
    createdAt: m.created_at
  }));
}

/**
 * Deletes a conversation; a 404 (already gone) is treated as success
 */
export async function deleteConversation(conversationId: string): Promise<void> {
  await requestDelete('/conversations/' + conversationId);
}

// ---------------------------------------------------------------------------
// Agent calls + tool loop
// ---------------------------------------------------------------------------

/** One input entry for an agent call: a user/assistant message or a tool result. */
export interface AgentInput {
  type?: string;
  role?: string;
  content?: string;
  tool_call_id?: string;
  result?: string;
}

/** A tool call an agent requested in its reply, with already-normalized arguments. */
export interface AgentToolCall {
  id: string;
  name: string;
  arguments: string | Record<string, unknown>;
}

/** Parsed result of one agent call: reply text, requested tool calls, and the conversation id. */
export interface AgentCallResult {
  conversationId: string;
  outputText: string;
  toolCalls: AgentToolCall[];
  rawOutputs: unknown[];
}

/**
 * Diagnostics for an agent reply that parsed to no text: the parsed text alone cannot distinguish
 * a tool-call-only reply, a guardrail block, or an unexpected output shape -- all look "empty".
 * Logs the parsed tool calls and the raw outputs so the next occurrence is diagnosable from the
 * container log alone.
 *
 * @param context What the caller was asking the agent for (e.g. "journal for Alice, attempt 1").
 * @param result The raw agent call result that yielded no text.
 */
export function logEmptyAgentReply(context: string, result: AgentCallResult): void {
  console.error(
    'ERROR Agent reply for ' +
      context +
      ' contained no text. Tool calls: ' +
      JSON.stringify(result.toolCalls) +
      '. Raw outputs: ' +
      JSON.stringify(result.rawOutputs)
  );
}

const OutputContentPartResponseSchema = z
  .object({
    type: z.string(),
    text: z.string().optional()
  })
  .passthrough();

const OutputContentResponseSchema = z.union([z.string(), z.array(OutputContentPartResponseSchema)]);

const AgentToolCallResponseSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  function: z.object({
    name: z.string(),
    arguments: z.union([z.string(), z.record(z.unknown())])
  })
});

const AgentOutputResponseSchema = z
  .object({
    type: z.string(),
    content: OutputContentResponseSchema.optional(),
    tool_calls: z.array(AgentToolCallResponseSchema).optional(),
    tool_call_id: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.union([z.string(), z.record(z.unknown())]).optional()
  })
  .passthrough();

const AgentCallResponseSchema = z.object({
  id: z.string().optional(),
  conversation_id: z.string().optional(),
  outputs: z.array(AgentOutputResponseSchema)
});

/** Joins the text parts of a single message.output's content (string, or array of {type, text} parts). */
function extractOutputText(content: z.infer<typeof OutputContentResponseSchema> | undefined): string {
  return extractContentText(content);
}
/**
 * Sends inputs to the agent (starting or continuing a conversation) and parses text + tool calls from the reply
 *
 * @param params The agent id, optional conversation id/name, the inputs to send, and store=false
 *   to ask Mistral not to persist a new conversation (one-shot calls; ignored when continuing one).
 * @returns The reply's text, requested tool calls, and the conversation id.
 * @throws MistralApiError on non-retryable HTTP failures after retries.
 */
export async function askAgent(params: {
  agentId: string;
  conversationId?: string;
  name?: string;
  inputs: AgentInput[];
  /** false = ask Mistral not to persist a new conversation (one-shot calls); ignored when continuing one */
  store?: boolean;
}): Promise<AgentCallResult> {
  const { agentId, conversationId, name, inputs, store } = params;

  const path = conversationId ? '/conversations/' + conversationId : '/conversations';
  const body = conversationId
    ? { inputs }
    : { agent_id: agentId, name, inputs, ...(store === undefined ? {} : { store }) };

  // Creating or appending a conversation is not idempotent, so safeRetry retries only typed HTTP
  // errors (429/5xx, provably uncommitted) and fails fast on ambiguous network errors.
  const data = await requestJson('POST', path, AgentCallResponseSchema, body, { safeRetry: true });
  const outputs = data.outputs;

  const outputText = outputs
    .filter(o => o.type === 'message.output')
    .map(o => extractOutputText(o.content))
    .filter(t => t.length > 0)
    .join(' ');

  // Tool calls can arrive either as a nested message.tool_calls entry, or as flat
  // function.call / function_call entries -- handle both shapes (mirrors chat_agent.ts).
  const toolCalls: AgentToolCall[] = [];
  for (const o of outputs) {
    if (o.type === 'message.tool_calls' && o.tool_calls) {
      for (const tc of o.tool_calls) {
        toolCalls.push({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
    } else if (o.type === 'function.call' || o.type === 'function_call') {
      toolCalls.push({
        id: o.tool_call_id || o.id || '',
        name: o.name || '',
        arguments: o.arguments ?? ''
      });
    }
  }

  return {
    conversationId: data.conversation_id || data.id || conversationId || '',
    outputText,
    toolCalls,
    rawOutputs: outputs
  };
}

/** Outcome of a full ask -> execute tools -> send results loop. */
export interface ToolLoopResult {
  conversationId: string;
  finalText: string;
  iterations: number;
}

/**
 * Generic ask -> execute tool calls -> send results loop, reusable by the pipeline's integrate phase
 *
 * @param params The agent id, the initial inputs, the iteration cap, and the tool executor.
 * @returns The final agent text, the conversation id, and the iterations actually run.
 */
export async function runAgentToolLoop(params: {
  agentId: string;
  initialInputs: AgentInput[];
  maxIterations: number;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}): Promise<ToolLoopResult> {
  const { agentId, initialInputs, maxIterations, executeTool } = params;

  let result = await askAgent({ agentId, inputs: initialInputs });
  let iterations = 0;

  while (result.toolCalls.length > 0 && iterations < maxIterations) {
    const toolInputs: AgentInput[] = [];

    for (const call of result.toolCalls) {
      let args: Record<string, unknown> = {};
      let parseError: string | null = null;

      if (typeof call.arguments === 'string') {
        try {
          args = JSON.parse(call.arguments);
        } catch (error) {
          console.error(
            'ERROR Failed to parse tool call arguments for ' +
              call.name +
              ': ' +
              error +
              ' (arguments length: ' +
              call.arguments.length +
              ' chars, tail: ' +
              JSON.stringify(call.arguments.slice(-80)) +
              ')'
          );
          parseError = String(error);
        }
      } else {
        args = call.arguments;
      }

      // The parse error rides back to the agent verbatim so it can actually correct the malformed
      // arguments (often a truncated long string) instead of guessing at a generic "invalid". When
      // the payload looks truncated (no closing quote near the end), say so explicitly: the agent
      // then knows to resend the full content instead of fiddling with the characters it can see.
      const truncatedHint =
        parseError !== null && typeof call.arguments === 'string' && !/"\s*[\]}]\s*$/.test(call.arguments)
          ? ' The arguments appear TRUNCATED -- resend the complete content, do not abbreviate it.'
          : '';
      const resultStr =
        parseError !== null
          ? '{"error":"arguments were not valid JSON: ' +
            parseError.replace(/"/g, "'") +
            truncatedHint +
            '"}'
          : await executeTool(call.name, args);

      toolInputs.push({
        type: 'function.result',
        tool_call_id: call.id,
        result: resultStr
      });
    }

    iterations++;
    result = await askAgent({ agentId, conversationId: result.conversationId, inputs: toolInputs });
  }

  return {
    conversationId: result.conversationId,
    finalText: result.outputText,
    iterations
  };
}

// ---------------------------------------------------------------------------
// Library documents
// ---------------------------------------------------------------------------

/** A document in the configured Mistral memory library (id + library path). */
export interface LibraryDocument {
  id: string;
  path: string;
  processStatus?: string;
  summary?: string | null;
}

const LibraryDocumentResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  process_status: z.string().optional(),
  summary: z.string().nullable().optional()
});

const LibraryDocumentsPageResponseSchema = z.object({
  data: z.array(LibraryDocumentResponseSchema).optional(),
  has_more: z.boolean().optional()
});

/** Maps a raw library-document response row to the LibraryDocument shape. */
function mapLibraryDocument(d: z.infer<typeof LibraryDocumentResponseSchema>): LibraryDocument {
  return {
    id: d.id,
    path: d.name,
    processStatus: d.process_status,
    summary: d.summary ?? null
  };
}

/**
 * Lists all documents in the configured memory library, paging defensively past 1000 entries.
 * NOTE: the pagination field names (page / page_size / has_more) are a best-effort guess that
 * could not be confirmed live -- reconfirm before the library ever approaches 1000 documents
 * (docs/nightly_memory_processing_implementation.md section 12.3).
 */
export async function listDocuments(): Promise<LibraryDocument[]> {
  const pageSize = 1000;
  // Hard cap independent of the server's has_more flag -- at single-family scale even a handful of
  // pages is already implausible, so this only ever kicks in to stop a misbehaving/misconfigured
  // response (e.g. has_more: true forever) from looping forever while the nightly lock is held.
  const maxPages = 100;
  const results: LibraryDocument[] = [];
  let page = 0;

  const seenIds = new Set<string>();
  for (; page < maxPages; page++) {
    const data = await requestJson(
      'GET',
      '/libraries/' + config.mistral.libraryId + '/documents?page=' + page + '&page_size=' + pageSize,
      LibraryDocumentsPageResponseSchema
    );

    const pageDocuments = data.data || [];
    let newInPage = 0;
    for (const doc of pageDocuments) {
      const id = doc.id;
      // Skip ids already returned by an earlier page so a server that ignores "page=" (returning
      // the full list every time) can't bloat the result with ~maxPages copies of each document.
      if (id === undefined) {
        results.push(mapLibraryDocument(doc));
        continue;
      }
      if (seenIds.has(id)) {
        continue;
      }
      seenIds.add(id);
      newInPage++;
      results.push(mapLibraryDocument(doc));
    }

    // A page that added no NEW ids means the API is re-serving the same list (or has no more
    // distinct data); stop rather than keep paginating toward the cap.
    if (newInPage === 0 && results.length > 0) {
      console.error('ERROR listDocuments server returned no new documents; stopping pagination early');
      break;
    }

    // Continue only while has_more is explicitly true; if it is missing/undefined (wrong field
    // name guess), fall back to continuing only while pages come back full, so a short/empty
    // page always terminates the loop instead of spinning forever.
    const hasMore =
      data.has_more === true || (data.has_more === undefined && pageDocuments.length >= pageSize);
    if (!hasMore) {
      break;
    }
  }

  if (page >= maxPages) {
    console.error(
      'ERROR listDocuments hit the ' + maxPages + '-page safety cap; returning what was fetched so far'
    );
  }

  return results;
}

/**
 * Uploads a new document to the memory library as multipart/form-data
 *
 * @param path The library path (and file name) to upload under.
 * @param content The document content (Markdown).
 * @returns The created library document.
 * @throws MistralApiError when the upload fails (e.g. HTTP 400 for empty content).
 */
export async function uploadDocument(path: string, content: string): Promise<LibraryDocument> {
  return withRetry(async () => {
    const formData = new FormData();
    const blob = new Blob([content], { type: 'text/markdown' });
    formData.append('file', blob, path);

    const response = await fetchWithTimeout(
      config.mistral.apiRoot + '/libraries/' + config.mistral.libraryId + '/documents',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + config.mistral.apiKey
        },
        body: formData
      }
    );

    if (!response.ok) {
      console.error('ERROR Mistral API upload document failed: HTTP ' + response.status + ' ' + path);
      throw new MistralApiError(
        'Mistral API upload document failed: HTTP ' + response.status,
        response.status
      );
    }

    const data = await response.json();
    return mapLibraryDocument(LibraryDocumentResponseSchema.parse(data));
  });
}

/**
 * Deletes a document from the memory library; a 404 (already gone) is treated as success
 */
export async function deleteDocument(documentId: string): Promise<void> {
  await requestDelete('/libraries/' + config.mistral.libraryId + '/documents/' + documentId);
}

/**
 * Replaces a document's content -- libraries have no in-place update, so this uploads the new content
 * first and only then deletes the superseded one. Uploading first means a mid-operation failure can at
 * worst leave a stale duplicate under the same path (logged, harmless) instead of a window where the
 * document is missing entirely from the library.
 *
 * @param path The library path to replace.
 * @param content The new document content.
 * @param oldDocumentId The superseded document to delete (optional).
 * @returns The newly uploaded document.
 */
export async function replaceDocument(
  path: string,
  content: string,
  oldDocumentId?: string
): Promise<LibraryDocument> {
  const doc = await uploadDocument(path, content);
  if (oldDocumentId) {
    try {
      await deleteDocument(oldDocumentId);
    } catch (error) {
      console.error(
        'ERROR Failed to delete superseded Mistral document ' +
          oldDocumentId +
          ' for "' +
          path +
          '": ' +
          error
      );
    }
  }
  return doc;
}
