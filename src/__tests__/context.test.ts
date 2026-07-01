import { contextService } from '../services/context.service';

describe('Context Service', () => {
  describe('getRelevantContext', () => {
    it('should retrieve background on the sender and format as XML', async () => {
      const { formattedContext, newlyLoadedTitles } = await contextService.getRelevantContext(
        'Hello',
        'zara',
        []
      );
      expect(formattedContext).toContain('<context_entry title="Background on Yasmin">');
      expect(formattedContext).toContain('<context_entry title="Background on the Family">');
      expect(formattedContext).toContain('<context_entry title="Background on Zara">');
      expect(formattedContext).toContain("Zara is Yasmin's older sister.");
      expect(newlyLoadedTitles).toContain('Background on Yasmin');
      expect(newlyLoadedTitles).toContain('Background on the Family');
      expect(newlyLoadedTitles).toContain('Background on Zara');
    });

    it('should retrieve only mandatory context entries (Yasmin, Family, and Sender) even if other people are mentioned', async () => {
      const { formattedContext, newlyLoadedTitles } = await contextService.getRelevantContext(
        'Tell me about samira and ellena',
        'christopher',
        []
      );
      expect(formattedContext).toContain('<context_entry title="Background on Yasmin">');
      expect(formattedContext).toContain('<context_entry title="Background on the Family">');
      expect(formattedContext).toContain('<context_entry title="Background on Christopher">');
      expect(formattedContext).not.toContain('<context_entry title="Background on Samira">');
      expect(formattedContext).not.toContain('<context_entry title="Background on Ellena">');
      expect(newlyLoadedTitles).toContain('Background on Yasmin');
      expect(newlyLoadedTitles).toContain('Background on the Family');
      expect(newlyLoadedTitles).toContain('Background on Christopher');
      expect(newlyLoadedTitles).not.toContain('Background on Samira');
      expect(newlyLoadedTitles).not.toContain('Background on Ellena');
    });

    it('should not load already loaded context titles', async () => {
      const alreadyLoaded = ['Background on Christopher', 'Background on Yasmin', 'Background on the Family'];
      const { formattedContext, newlyLoadedTitles } = await contextService.getRelevantContext(
        'Tell me about samira',
        'christopher',
        alreadyLoaded
      );
      expect(formattedContext).toBe('');
      expect(newlyLoadedTitles).toEqual([]);
    });
  });
});
