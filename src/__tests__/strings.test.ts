import { capitalize, capitalizeWord, profileTitle, sanitizeForPath } from '../strings';

describe('strings', () => {
  describe('sanitizeForPath', () => {
    it('lower-cases and replaces every non [a-z0-9-] character with a hyphen', () => {
      expect(sanitizeForPath('Mary Jane')).toBe('mary-jane');
      expect(sanitizeForPath("O'Brien")).toBe('o-brien');
      expect(sanitizeForPath('Ausflüge')).toBe('ausfl-ge');
      expect(sanitizeForPath('already-clean')).toBe('already-clean');
      expect(sanitizeForPath('x 9')).toBe('x-9');
    });

    it('is idempotent -- a sanitized slug sanitizes to itself', () => {
      expect(sanitizeForPath(sanitizeForPath('Mary Jane'))).toBe(sanitizeForPath('Mary Jane'));
    });
  });

  describe('capitalize', () => {
    it('upper-cases only the first character and leaves the rest untouched', () => {
      expect(capitalize('hello')).toBe('Hello');
      expect(capitalize('annaLise')).toBe('AnnaLise');
    });

    it('handles the empty string', () => {
      expect(capitalize('')).toBe('');
    });
  });

  describe('capitalizeWord', () => {
    it('upper-cases the first character and lower-cases the rest', () => {
      expect(capitalizeWord('mary')).toBe('Mary');
      expect(capitalizeWord('jANE')).toBe('Jane');
    });

    it('handles the empty string', () => {
      expect(capitalizeWord('')).toBe('');
    });
  });

  describe('profileTitle', () => {
    it('embeds the name verbatim, without any case normalization', () => {
      expect(profileTitle('Zara')).toBe('Profile of Zara');
      expect(profileTitle('mary-jane')).toBe('Profile of mary-jane');
    });
  });
});
