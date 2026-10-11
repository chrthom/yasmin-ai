import { extractContentText } from '../mistral/content';

describe('extractContentText', () => {
  it('should return string content unchanged', () => {
    expect(extractContentText('Simple text response')).toBe('Simple text response');
  });

  it('should return empty string for undefined content', () => {
    expect(extractContentText(undefined)).toBe('');
  });

  it('should return empty string for null content', () => {
    expect(extractContentText(null)).toBe('');
  });

  it('should join text parts with spaces', () => {
    const content = [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'world!' }
    ];
    expect(extractContentText(content)).toBe('Hello world!');
  });

  it('should skip non-text parts', () => {
    const content = [
      { type: 'thinking', text: 'Let me search...' },
      { type: 'text', text: 'Answer' },
      { type: 'image', text: '' }
    ];
    expect(extractContentText(content)).toBe('Answer');
  });

  it('should skip text parts whose text is not a string', () => {
    const content = [{ type: 'text', text: 42 }, { type: 'text' }, { type: 'text', text: 'Valid' }];
    expect(extractContentText(content)).toBe('Valid');
  });

  it('should skip non-object parts', () => {
    const content = ['plain string', 42, null, { type: 'text', text: 'Valid' }];
    expect(extractContentText(content)).toBe('Valid');
  });

  it('should return empty string for an array without text parts', () => {
    const content = [
      { type: 'thinking', text: 'Hmm...' },
      { type: 'image', text: '' }
    ];
    expect(extractContentText(content)).toBe('');
  });

  it('should return empty string for an empty array', () => {
    expect(extractContentText([])).toBe('');
  });

  it('should return empty string for other non-string, non-array content', () => {
    expect(extractContentText(42)).toBe('');
    expect(extractContentText({ type: 'text', text: 'nested' })).toBe('');
  });
});
