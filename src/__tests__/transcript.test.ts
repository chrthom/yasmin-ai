import { isDialogueMessage } from '../mistral/transcript';

describe('isDialogueMessage', () => {
  it.each([
    'message.tool_calls',
    'TOOL.result',
    'function.call',
    'FUNCTION.result',
    'system.message',
    'service.event',
    'message.ERROR'
  ])('excludes internal rows by type, ignoring case: %s', type => {
    expect(isDialogueMessage({ type, role: 'assistant', content: 'not dialogue' })).toBe(false);
  });

  it.each(['message.input', 'message.output', 'other'])('retains non-plumbing types: %s', type => {
    expect(isDialogueMessage({ type, role: 'system' })).toBe(true);
  });
});
