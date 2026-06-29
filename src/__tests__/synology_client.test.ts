import { SynologyClient } from '../synology_client';

describe('SynologyClient', () => {
  let synologyClient: SynologyClient;

  beforeEach(() => {
    synologyClient = new SynologyClient('https://test.url', 'test-token');
  });

  describe('formatAnswer', () => {
    it('should remove markdown bold formatting', () => {
      const result = synologyClient.formatAnswer('This is **bold** text');
      expect(result).toBe('This is bold text');
    });

    it('should remove markdown headers', () => {
      const result = synologyClient.formatAnswer('# Header 1\n## Header 2');
      expect(result).toBe('Header 1\n Header 2');
    });

    it('should trim whitespace', () => {
      const result = synologyClient.formatAnswer('  text with spaces  ');
      expect(result).toBe('text with spaces');
    });

    it('should handle multiple markdown patterns', () => {
      const result = synologyClient.formatAnswer('# **Title**\n\nSome **bold** text');
      expect(result).toBe('Title\n\nSome bold text');
    });

    it('should handle empty string', () => {
      const result = synologyClient.formatAnswer('');
      expect(result).toBe('');
    });
  });

  describe('chunkText', () => {
    it('should chunk text by newlines when possible', () => {
      const longText = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10';
      const chunks = synologyClient.chunkText(longText, 20);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0]).toBe('line1\nline2\nline3');
    });

    it('should chunk text at specified length when no newlines', () => {
      const longText = 'a'.repeat(2000);
      const chunks = synologyClient.chunkText(longText, 100);
      expect(chunks.length).toBe(20);
      expect(chunks[0].length).toBe(100);
    });

    it('should handle text shorter than chunk size', () => {
      const shortText = 'short text';
      const chunks = synologyClient.chunkText(shortText, 100);
      expect(chunks.length).toBe(1);
      expect(chunks[0]).toBe(shortText);
    });

    it('should use default chunk size of 1800', () => {
      const longText = 'a'.repeat(2000);
      const chunks = synologyClient.chunkText(longText);
      expect(chunks.length).toBe(2);
      expect(chunks[0].length).toBeLessThanOrEqual(1800);
    });
  });

  describe('sendAnswersToChat', () => {
    it('should be defined', () => {
      expect(synologyClient.sendAnswersToChat).toBeDefined();
    });

    // Note: Actual network calls would need to be mocked for full testing
    // This is just a basic test to ensure the method exists
  });
});
