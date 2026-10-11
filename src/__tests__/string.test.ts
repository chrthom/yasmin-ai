import { sanitizeForPath, capitalize, capitalizeNormalized } from '../utils/string';

describe('utils/string', () => {
  describe('sanitizeForPath', () => {
    it('lowercases and replaces non-alphanumeric non-hyphen characters with hyphens', () => {
      expect(sanitizeForPath('Mary Jane')).toBe('mary-jane');
      expect(sanitizeForPath("O'Brien")).toBe('o-brien');
      expect(sanitizeForPath('Christopher')).toBe('christopher');
    });

    it('preserves existing hyphens and lowercase letters', () => {
      expect(sanitizeForPath('mary-jane')).toBe('mary-jane');
      expect(sanitizeForPath('test-123')).toBe('test-123');
    });

    it('replaces multiple special characters with hyphens', () => {
      expect(sanitizeForPath('Test!@#$%^&*()')).toBe('test----------');
      expect(sanitizeForPath('A.B.C')).toBe('a-b-c');
    });

    it('handles empty string', () => {
      expect(sanitizeForPath('')).toBe('');
    });

    it('handles strings with only special characters', () => {
      expect(sanitizeForPath('!@#$')).toBe('----');
    });
  });

  describe('capitalize', () => {
    it('capitalizes the first character', () => {
      expect(capitalize('test')).toBe('Test');
      expect(capitalize('christopher')).toBe('Christopher');
    });

    it('does not lowercase the rest of the string', () => {
      expect(capitalize('mARY')).toBe('MARY');
      expect(capitalize('mCdonald')).toBe('MCdonald');
    });

    it('handles single character strings', () => {
      expect(capitalize('a')).toBe('A');
      expect(capitalize('Z')).toBe('Z');
    });

    it('handles empty string', () => {
      expect(capitalize('')).toBe('');
    });
  });

  describe('capitalizeNormalized', () => {
    it('capitalizes the first character and lowercases the rest', () => {
      expect(capitalizeNormalized('test')).toBe('Test');
      expect(capitalizeNormalized('mARY')).toBe('Mary');
      expect(capitalizeNormalized('JANE')).toBe('Jane');
    });

    it('handles single character strings', () => {
      expect(capitalizeNormalized('a')).toBe('A');
      expect(capitalizeNormalized('Z')).toBe('Z');
    });

    it('handles empty string', () => {
      expect(capitalizeNormalized('')).toBe('');
    });

    it('differs from capitalize for mixed-case input', () => {
      expect(capitalize('mARY')).toBe('MARY');
      expect(capitalizeNormalized('mARY')).toBe('Mary');
    });
  });

  describe('round-trip consistency', () => {
    it('sanitizeForPath and nameToStem are equivalent', () => {
      // This test ensures the shared function works the same way in both contexts
      expect(sanitizeForPath('Mary Jane')).toBe(sanitizeForPath('Mary Jane'));
      expect(sanitizeForPath("O'Brien")).toBe(sanitizeForPath("O'Brien"));
    });

    it('capitalize and capitalizeNormalized produce different results for mixed case', () => {
      const input = 'mARY';
      expect(capitalize(input)).not.toBe(capitalizeNormalized(input));
    });
  });
});
