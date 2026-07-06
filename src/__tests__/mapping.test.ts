import { pathToTitle, titleToPath } from '../nightly/mapping';

describe('nightly/mapping', () => {
  describe('pathToTitle', () => {
    it('maps the fixed self-reflection profile path', () => {
      expect(pathToTitle('self-reflection/profile.md')).toBe('Profile of Yasmin');
    });

    it('maps the fixed family notes path', () => {
      expect(pathToTitle('general/family.md')).toBe('Family notes');
    });

    it('maps a single-word people/ stem', () => {
      expect(pathToTitle('people/christopher.md')).toBe('Profile of Christopher');
    });

    it('maps a multi-word hyphenated people/ stem', () => {
      expect(pathToTitle('people/mary-jane.md')).toBe('Profile of Mary Jane');
    });

    it('returns null for an unmapped path', () => {
      expect(pathToTitle('journals/christopher/conv123.md')).toBeNull();
    });
  });

  describe('titleToPath', () => {
    it('maps "Profile of Yasmin" back to the fixed self-reflection path', () => {
      expect(titleToPath('Profile of Yasmin')).toBe('self-reflection/profile.md');
    });

    it('maps "Family notes" back to the fixed family path', () => {
      expect(titleToPath('Family notes')).toBe('general/family.md');
    });

    it('maps a single-word "Profile of <Name>" title back to a people/ path', () => {
      expect(titleToPath('Profile of Christopher')).toBe('people/christopher.md');
    });

    it('maps a multi-word "Profile of <Name>" title back to a hyphenated people/ path', () => {
      expect(titleToPath('Profile of Mary Jane')).toBe('people/mary-jane.md');
    });

    it('returns null for an unrecognized title', () => {
      expect(titleToPath('Session with Christopher')).toBeNull();
    });
  });

  describe('round-trip', () => {
    it('round-trips self-reflection/profile.md <-> Profile of Yasmin', () => {
      const title = pathToTitle('self-reflection/profile.md');
      expect(titleToPath(title as string)).toBe('self-reflection/profile.md');
    });

    it('round-trips general/family.md <-> Family notes', () => {
      const title = pathToTitle('general/family.md');
      expect(titleToPath(title as string)).toBe('general/family.md');
    });

    it('round-trips people/christopher.md <-> Profile of Christopher', () => {
      const title = pathToTitle('people/christopher.md');
      expect(titleToPath(title as string)).toBe('people/christopher.md');
    });

    it('round-trips people/mary-jane.md <-> Profile of Mary Jane', () => {
      const title = pathToTitle('people/mary-jane.md');
      expect(titleToPath(title as string)).toBe('people/mary-jane.md');
    });
  });
});
