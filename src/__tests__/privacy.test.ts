import { isOverCap, stripArchiveSection, stripSensitive, truncateToCap } from '../nightly/privacy';

describe('privacy', () => {
  describe('stripSensitive', () => {
    it('removes a single block and preserves surrounding text', () => {
      const content = 'Before text.\n[PRIVACY:SENSITIVE]\nsecret stuff\n[/PRIVACY:SENSITIVE]\nAfter text.';

      const result = stripSensitive(content);

      expect(result).toBe('Before text.\n\nAfter text.');
    });

    it('removes multiple blocks in one document', () => {
      const content = [
        'Intro.',
        '[PRIVACY:SENSITIVE]',
        'first secret',
        '[/PRIVACY:SENSITIVE]',
        'Middle text.',
        '[PRIVACY:SENSITIVE]',
        'second secret',
        'spanning lines',
        '[/PRIVACY:SENSITIVE]',
        'Outro.'
      ].join('\n');

      const result = stripSensitive(content);

      expect(result).not.toMatch(/PRIVACY:SENSITIVE/);
      expect(result).not.toMatch(/secret/);
      expect(result).toContain('Intro.');
      expect(result).toContain('Middle text.');
      expect(result).toContain('Outro.');
      expect(result.indexOf('Intro.')).toBeLessThan(result.indexOf('Middle text.'));
      expect(result.indexOf('Middle text.')).toBeLessThan(result.indexOf('Outro.'));
    });

    it('leaves content completely unchanged when no block is present', () => {
      const content = 'Just plain, ordinary content with no markers at all.';

      const result = stripSensitive(content);

      expect(result).toBe(content);
    });

    it('collapses excessive blank lines left behind by a removed block', () => {
      const content = 'Before.\n\n\n[PRIVACY:SENSITIVE]\nsecret\n[/PRIVACY:SENSITIVE]\n\n\n\nAfter.';

      const result = stripSensitive(content);

      expect(result).not.toMatch(/\n{3,}/);
      expect(result).toContain('Before.');
      expect(result).toContain('After.');
    });

    it('fails closed on a dangling opener by stripping to the end of content', () => {
      const content =
        'Some public text.\n[PRIVACY:SENSITIVE]\nleftover secret\nthat never got closed\nand more after';

      const result = stripSensitive(content);

      expect(result).not.toMatch(/PRIVACY:SENSITIVE/);
      expect(result).not.toMatch(/secret/);
      expect(result).toContain('Some public text.');
      expect(result).not.toContain('leftover');
    });

    it('fails closed on a stray closer by stripping from the start of content', () => {
      const content = 'Shielded material from before\n[/PRIVACY:SENSITIVE]\nclean trailing text';

      const result = stripSensitive(content);

      expect(result).not.toMatch(/PRIVACY:SENSITIVE/);
      expect(result).not.toContain('Shielded material');
      expect(result).toContain('clean trailing text');
    });
  });

  describe('isOverCap', () => {
    it('returns true when content length exceeds the cap', () => {
      expect(isOverCap('abcdef', 5)).toBe(true);
    });

    it('returns false when content length equals the cap', () => {
      expect(isOverCap('abcde', 5)).toBe(false);
    });

    it('returns false when content length is under the cap', () => {
      expect(isOverCap('abc', 5)).toBe(false);
    });
  });

  describe('truncateToCap', () => {
    it('returns content unchanged when at or under the cap', () => {
      const content = 'short text';

      expect(truncateToCap(content, content.length)).toBe(content);
      expect(truncateToCap(content, content.length + 10)).toBe(content);
    });

    it('truncates content over the cap and appends the marker', () => {
      const content = 'a'.repeat(100);
      const maxChars = 20;

      const result = truncateToCap(content, maxChars);

      expect(result.length).toBeLessThanOrEqual(maxChars);
      expect(result.endsWith('…[truncated]')).toBe(true);
    });

    it('keeps the combined length within maxChars for a range of caps at or above the marker length', () => {
      const content = 'a'.repeat(200);

      for (const maxChars of [12, 13, 25, 50, 199]) {
        const result = truncateToCap(content, maxChars);
        expect(result.length).toBeLessThanOrEqual(maxChars);
        expect(result.endsWith('…[truncated]')).toBe(true);
      }
    });
  });

  describe('stripArchiveSection', () => {
    it('removes a trailing ## Archiv section but keeps everything before it', () => {
      const content = '## Core Facts\nAlice is 34.\n\n## Archiv\nAlice used to play piano.';
      expect(stripArchiveSection(content)).toBe('## Core Facts\nAlice is 34.');
    });
    it('returns content unchanged when there is no Archiv heading', () => {
      const content = '## Core Facts\nAlice is 34.';
      expect(stripArchiveSection(content)).toBe(content);
    });
    it('ignores a subsection heading that merely contains the word Archiv', () => {
      const content = '## Core Facts\n### Archiviertes Detail\nSome text.';
      expect(stripArchiveSection(content)).toBe(content);
    });
  });
});
