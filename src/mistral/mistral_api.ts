import { z } from 'zod';
import { config } from '../config';

// ---------------------------------------------------------------------------
// Errors + retry
// ---------------------------------------------------------------------------

export class MistralApiError extends Error {
  public readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'MistralApiError';
    this.status = status;
  }
}

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  jitter?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Runs fn with exponential-backoff retry on network errors and 429/5xx MistralApiErrors; other 4xx fail fast
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
      const retryable = !isApiError || status === 429 || (typeof status === 'number' && status >= 500);

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

    const response = await fetch(config.mistral.apiRoot + path, init);

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
 */
async function requestDelete(path: string, opts?: RetryOptions): Promise<void> {
  await withRetry(async () => {
    const response = await fetch(config.mistral.apiRoot + path, {
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

export interface ConversationMeta {
  id: string;
  name?: string;
  agentId?: string;
  updatedAt: string;
}

const ConversationMetaResponseSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  agent_id: z.string().optional(),
  updated_at: z.string()
});

const ConversationListResponseSchema = z.array(ConversationMetaResponseSchema);

/**
 * Lists conversations updated at or after sinceIso (client-side filter, no pagination, mirrors chat_agent.ts)
 */
export async function listConversations(sinceIso: string): Promise<ConversationMeta[]> {
  const data = await requestJson('GET', '/conversations', ConversationListResponseSchema);
  const sinceMs = Date.parse(sinceIso);

  return data
    .filter(c => Date.parse(c.updated_at) >= sinceMs)
    .map(c => ({
      id: c.id,
      name: c.name,
      agentId: c.agent_id,
      updatedAt: c.updated_at
    }));
}

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

const ConversationMessagesResponseSchema = z.array(ConversationMessageResponseSchema);

/**
 * Fetches the full message history for a conversation
 */
export async function getConversationMessages(conversationId: string): Promise<ConversationMessage[]> {
  const data = await requestJson(
    'GET',
    '/conversations/' + conversationId + '/messages',
    ConversationMessagesResponseSchema
  );

  return data.map(m => ({
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

export interface AgentInput {
  type?: string;
  role?: string;
  content?: string;
  tool_call_id?: string;
  result?: string;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: string | Record<string, unknown>;
}

export interface AgentCallResult {
  conversationId: string;
  outputText: string;
  toolCalls: AgentToolCall[];
  rawOutputs: unknown[];
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

// Joins the text parts of a single message.output's content (string, or array of {type, text} parts)
function extractOutputText(content: z.infer<typeof OutputContentResponseSchema> | undefined): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(p => p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text as string)
      .join(' ');
  }
  return '';
}

/**
 * Sends inputs to the agent (starting or continuing a conversation) and parses text + tool calls from the reply
 */
export async function askAgent(params: {
  agentId: string;
  conversationId?: string;
  name?: string;
  inputs: AgentInput[];
}): Promise<AgentCallResult> {
  const { agentId, conversationId, name, inputs } = params;

  const path = conversationId ? '/conversations/' + conversationId : '/conversations';
  const body = conversationId ? { inputs } : { agent_id: agentId, name, inputs };

  const data = await requestJson('POST', path, AgentCallResponseSchema, body);
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

export interface ToolLoopResult {
  conversationId: string;
  finalText: string;
  iterations: number;
}

/**
 * Generic ask -> execute tool calls -> send results loop, reusable by the pipeline's integrate phase
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
      let parseFailed = false;

      if (typeof call.arguments === 'string') {
        try {
          args = JSON.parse(call.arguments);
        } catch (error) {
          console.error('ERROR Failed to parse tool call arguments for ' + call.name + ': ' + error);
          parseFailed = true;
        }
      } else {
        args = call.arguments;
      }

      const resultStr = parseFailed ? '{"error":"invalid arguments"}' : await executeTool(call.name, args);

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

function mapLibraryDocument(d: z.infer<typeof LibraryDocumentResponseSchema>): LibraryDocument {
  return {
    id: d.id,
    path: d.name,
    processStatus: d.process_status,
    summary: d.summary ?? null
  };
}

// NOTE: pagination field names for this endpoint (page / page_size / has_more) are a best-effort
// guess -- they could NOT be confirmed live against a production API key for this task. Reconfirm
// against a live key before this deployment's library ever approaches 1000 documents (see
// docs/nightly_memory_processing_implementation.md section 12.3). At single-family scale this
// loop will almost always run exactly once.
/**
 * Lists all documents in the configured memory library, paging defensively past 1000 entries
 */
export async function listDocuments(): Promise<LibraryDocument[]> {
  const pageSize = 1000;
  const results: LibraryDocument[] = [];
  let page = 0;

  for (;;) {
    const data = await requestJson(
      'GET',
      '/libraries/' + config.mistral.libraryId + '/documents?page=' + page + '&page_size=' + pageSize,
      LibraryDocumentsPageResponseSchema
    );

    const pageDocuments = data.data || [];
    results.push(...pageDocuments.map(mapLibraryDocument));

    // Continue only while has_more is explicitly true; if it is missing/undefined (wrong field
    // name guess), fall back to continuing only while pages come back full, so a short/empty
    // page always terminates the loop instead of spinning forever.
    const hasMore =
      data.has_more === true || (data.has_more === undefined && pageDocuments.length >= pageSize);
    if (!hasMore) {
      break;
    }
    page++;
  }

  return results;
}

/**
 * Uploads a new document to the memory library as multipart/form-data
 */
export async function uploadDocument(path: string, content: string): Promise<LibraryDocument> {
  return withRetry(async () => {
    const formData = new FormData();
    const blob = new Blob([content], { type: 'text/markdown' });
    formData.append('file', blob, path);

    const response = await fetch(
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
 * Reads the raw text content of a document -- recovery/verification tool only, not on the hot path
 */
export async function getTextContent(documentId: string): Promise<string> {
  return withRetry(async () => {
    const response = await fetch(
      config.mistral.apiRoot +
        '/libraries/' +
        config.mistral.libraryId +
        '/documents/' +
        documentId +
        '/text_content',
      {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + config.mistral.apiKey
        }
      }
    );

    if (!response.ok) {
      console.error('ERROR Mistral API get text content failed: HTTP ' + response.status + ' ' + documentId);
      throw new MistralApiError(
        'Mistral API get text content failed: HTTP ' + response.status,
        response.status
      );
    }

    return response.text();
  });
}

/**
 * Replaces a document's content -- libraries have no in-place update, so this deletes then re-uploads (in that order)
 */
export async function replaceDocument(
  path: string,
  content: string,
  oldDocumentId?: string
): Promise<LibraryDocument> {
  if (oldDocumentId) {
    await deleteDocument(oldDocumentId);
  }
  return uploadDocument(path, content);
}
