import { tokenize, tfIdfService } from '../services/tfidf.service';
import { contextService } from '../services/context.service';

describe('TF-IDF and Context Services', () => {
  describe('tokenize', () => {
    it('should lowercase and tokenize text', () => {
      const tokens = tokenize('Hello, Zara! How is Christopher?');
      expect(tokens).toEqual(['hello', 'zara', 'how', 'is', 'christopher']);
    });

    it('should handle empty string', () => {
      const tokens = tokenize('');
      expect(tokens).toEqual([]);
    });
  });

  describe('matchTitles', () => {
    it('should match the most relevant titles based on similarity', () => {
      const titles = [
        'Background on anjali',
        'Background on zara',
        'Background on christopher',
        'Some unrelated topic'
      ];
      const results = tfIdfService.matchTitles('Tell me about Zara', titles, 2);
      expect(results[0].title).toBe('Background on zara');
      expect(results[0].score).toBeGreaterThan(0);
    });
  });

  describe('getRelevantContext', () => {
    it('should retrieve background on the sender and format as XML', async () => {
      const { formattedContext, newlyLoadedTitles } = await contextService.getRelevantContext(
        'Hello',
        'zara',
        []
      );
      expect(formattedContext).toContain('<context_entry title="Background on zara">');
      expect(formattedContext).toContain('Zara is 13 years old');
      expect(newlyLoadedTitles).toContain('Background on zara');
    });

    it('should match related people mentioned in prompt and format as XML', async () => {
      const { formattedContext, newlyLoadedTitles } = await contextService.getRelevantContext(
        'Tell me about samira and ellena',
        'christopher',
        []
      );
      expect(formattedContext).toContain('<context_entry title="Background on christopher">');
      expect(formattedContext).toContain('<context_entry title="Background on samira">');
      expect(formattedContext).toContain('<context_entry title="Background on ellena">');
      expect(newlyLoadedTitles).toContain('Background on christopher');
      expect(newlyLoadedTitles).toContain('Background on samira');
      expect(newlyLoadedTitles).toContain('Background on ellena');
    });

    it('should not load already loaded context titles', async () => {
      const alreadyLoaded = ['Background on christopher'];
      const { formattedContext, newlyLoadedTitles } = await contextService.getRelevantContext(
        'Tell me about samira',
        'christopher',
        alreadyLoaded
      );
      expect(formattedContext).not.toContain('Background on christopher');
      expect(formattedContext).toContain('Background on samira');
      expect(newlyLoadedTitles).toContain('Background on samira');
      expect(newlyLoadedTitles).not.toContain('Background on christopher');
    });
  });
});
