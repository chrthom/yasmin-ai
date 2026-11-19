import { extractToolCalls } from '../mistral/tool_calls';

describe('extractToolCalls', () => {
  it('extracts nested and both flat shapes in order without parsing arguments', () => {
    const args = { title: 'Family notes' };
    expect(
      extractToolCalls<string | typeof args>([
        { type: 'message.output' },
        {
          type: 'message.tool_calls',
          tool_calls: [
            { id: 'nested-1', function: { name: 'first', arguments: '{invalid' } },
            { id: 'nested-2', function: { name: 'second', arguments: args } }
          ]
        },
        { type: 'function.call', tool_call_id: 'preferred', id: 'other', name: 'third', arguments: '{}' },
        { type: 'function_call', tool_call_id: '', id: 'fallback', name: 'fourth', arguments: args }
      ])
    ).toEqual([
      { source: 'nested', id: 'nested-1', name: 'first', arguments: '{invalid' },
      { source: 'nested', id: 'nested-2', name: 'second', arguments: args },
      { source: 'flat', id: 'preferred', name: 'third', arguments: '{}' },
      { source: 'flat', id: 'fallback', name: 'fourth', arguments: args }
    ]);
  });

  it('ignores missing and empty nested lists but preserves missing flat fields', () => {
    expect(
      extractToolCalls([
        { type: 'message.tool_calls' },
        { type: 'message.tool_calls', tool_calls: [] },
        { type: 'function.call' },
        { type: 'function_call', id: '', name: '', arguments: '' }
      ])
    ).toEqual([
      { source: 'flat', id: undefined, name: undefined, arguments: undefined },
      { source: 'flat', id: '', name: '', arguments: '' }
    ]);
  });

  it('passes malformed flat values and missing nested fields through without validation', () => {
    expect(
      extractToolCalls([
        { type: 'function.call', tool_call_id: 42, name: null, arguments: null },
        { type: 'message.tool_calls', tool_calls: [{ function: {} }] }
      ] as any)
    ).toEqual([
      { source: 'flat', id: 42, name: null, arguments: null },
      { source: 'nested', id: undefined, name: undefined, arguments: undefined }
    ]);
  });

  it.each([
    [{ type: 'message.tool_calls', tool_calls: [{}] }],
    [{ type: 'message.tool_calls', tool_calls: [null] }],
    [{ type: 'message.tool_calls', tool_calls: {} }],
    [null]
  ])('throws for malformed nested structures as the live caller previously did', (...outputs) => {
    expect(() => extractToolCalls(outputs as any)).toThrow(TypeError);
  });
});
