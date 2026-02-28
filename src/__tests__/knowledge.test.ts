import { Knowledge } from '../knowledge';

describe('Knowledge', () => {
  let knowledge: Knowledge;

  beforeEach(() => {
    knowledge = new Knowledge();
  });

  describe('getFamilyRelationTo', () => {
    it('should return correct family relations for known users', () => {
      expect(knowledge.getFamilyRelationTo('anjali')).toBe('daughter');
      expect(knowledge.getFamilyRelationTo('christopher')).toBe('daughter');
      expect(knowledge.getFamilyRelationTo('zara')).toBe('younger sister');
      expect(knowledge.getFamilyRelationTo('samira')).toBe('older sister');
      expect(knowledge.getFamilyRelationTo('ellena')).toBe('older sister');
      expect(knowledge.getFamilyRelationTo('helge')).toBe('granddaughter');
      expect(knowledge.getFamilyRelationTo('christine')).toBe('granddaughter');
      expect(knowledge.getFamilyRelationTo('lennard')).toBe('niece');
      expect(knowledge.getFamilyRelationTo('jonas')).toBe('niece');
    });

    it('should return "distant relative" for unknown users', () => {
      expect(knowledge.getFamilyRelationTo('unknown')).toBe('distant relative');
      expect(knowledge.getFamilyRelationTo('')).toBe('distant relative');
    });
  });

  describe('getAgeOf', () => {
    it('should return correct ages for known users', () => {
      expect(knowledge.getAgeOf('anjali')).toBe(36);
      expect(knowledge.getAgeOf('christopher')).toBe(36);
      expect(knowledge.getAgeOf('zara')).toBe(13);
      expect(knowledge.getAgeOf('samira')).toBe(5);
      expect(knowledge.getAgeOf('ellena')).toBe(2);
      expect(knowledge.getAgeOf('helge')).toBe(57);
      expect(knowledge.getAgeOf('christine')).toBe(56);
      expect(knowledge.getAgeOf('lennard')).toBe(34);
      expect(knowledge.getAgeOf('jonas')).toBe(29);
    });

    it('should return default age (30) for unknown users', () => {
      expect(knowledge.getAgeOf('unknown')).toBe(30);
      expect(knowledge.getAgeOf('')).toBe(30);
    });
  });
});