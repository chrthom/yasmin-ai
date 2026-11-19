/** The response fields used to extract nested and flat tool calls. */
export interface ToolCallOutput<Arguments> {
  type: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: Arguments } }>;
  tool_call_id?: string;
  id?: string;
  name?: string;
  arguments?: Arguments;
}

/** A raw call, tagged so callers can apply their own flat-call defaults. */
export type ExtractedToolCall<Arguments> =
  | { source: 'nested'; id: string; name: string; arguments: Arguments }
  | { source: 'flat'; id: string | undefined; name: string | undefined; arguments: Arguments | undefined };

/**
 * Extracts calls in response order without validating fields or parsing arguments.
 * Missing or malformed fields retain the callers' existing pass-through or failure behavior.
 *
 * @param outputs Response entries containing nested or flat calls.
 * @returns Raw tool calls, with their source shape preserved for caller-specific defaults.
 * @throws {TypeError} If a nested call lacks its function object, a truthy tool_calls value is
 *   not iterable, or a response entry or nested call is null or undefined.
 */
export function extractToolCalls<Arguments>(
  outputs: readonly ToolCallOutput<Arguments>[]
): ExtractedToolCall<Arguments>[] {
  const calls: ExtractedToolCall<Arguments>[] = [];
  for (const output of outputs) {
    if (output.type === 'message.tool_calls' && output.tool_calls) {
      for (const call of output.tool_calls) {
        calls.push({
          source: 'nested',
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments
        });
      }
    } else if (output.type === 'function.call' || output.type === 'function_call') {
      calls.push({
        source: 'flat',
        id: output.tool_call_id || output.id,
        name: output.name,
        arguments: output.arguments
      });
    }
  }
  return calls;
}
