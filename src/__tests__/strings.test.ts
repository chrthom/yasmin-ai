import { capitalizeLowerRest, capitalizePreserveRest, profileTitle, sanitizeForPath } from '../strings';

describe('strings', () => {
  describe('sanitizeForPath', () => {
    it('lower-cases the input', () => {
      expect(sanitizeForPath('Christopher')).toBe('christopher');
    });

    it('replaces spaces and punctuation with hyphens so titles become valid file stems', () => {
      expect(sanitizeForPath('Mary Jane')).toBe('mary-jane');
      expect(sanitizeForPath("O'Brien")).toBe('o-brien');
      expect(sanitizeForPath('Jean-Luc')).toBe('jean-luc');
    });

    it('replaces non-ASCII characters, since the stem alphabet is [a-z0-9-]', () => {
      expect(sanitizeForPath('ana maría')).toBe('ana-mar-a');
      expect(sanitizeForPath('Zoë')).toBe('zo-');
    });

    it('keeps digits and hyphens', () => {
      expect(sanitizeForPath('User 42')).toBe('user-42');
      expect(sanitizeForPath('mary--jane')).toBe('mary--jane');
    });

    it('leaves already-sanitized stems untouched', () => {
      expect(sanitizeForPath('mary-jane')).toBe('mary-jane');
    });
  });

  describe('capitalizePreserveRest', () => {
    it('upper-cases only the first character and preserves the rest as typed', () => {
      expect(capitalizePreserveRest('mary')).toBe('Mary');
      expect(capitalizePreserveRest('McNeal')).toBe('McNeal');
      expect(capitalizePreserveRest("o'brien")).toBe("O'brien");
    });

    it('does not lower-case the rest, unlike capitalizeLowerRest', () => {
      expect(capitalizePreserveRest('MARY')).toBe('MARY');
      expect(capitalizeLowerRest('MARY')).toBe('Mary');
    });

    it('returns the empty string unchanged', () => {
      expect(capitalizePreserveRest('')).toBe('');
    });
  });

  describe('capitalizeLowerRest', () => {
    it('upper-cases the first character and lower-cases the rest', () => {
      expect(capitalizeLowerRest('mary')).toBe('Mary');
      expect(capitalizeLowerRest('MARY')).toBe('Mary');
      expect(capitalizeLowerRest('jANE')).toBe('Jane');
    });

    it('returns the empty string unchanged', () => {
      expect(capitalizeLowerRest('')).toBe('');
    });
  });

  describe('profileTitle', () => {
    it('builds the canonical context_entries title for a person', () => {
      expect(profileTitle('Mary')).toBe('Profile of Mary');
    });

    it('performs no case normalization of its own -- lookups are case-insensitive', () => {
      expect(profileTitle('christopher')).toBe('Profile of christopher');
    });
  });
});
