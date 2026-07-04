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
      expect(formattedContext).toContain('<context_entry title="Background on Zara">');
      expect(formattedContext).toContain("Zara is Yasmin's older sister.");
      expect(newlyLoadedTitles).toContain('Background on Yasmin');
      expect(newlyLoadedTitles).toContain('Background on Zara');
    });

    it('should retrieve only mandatory context entries (Yasmin and Sender) even if other people are mentioned', async () => {
      const { formattedContext, newlyLoadedTitles } = await contextService.getRelevantContext(
        'Tell me about samira and ellena',
        'christopher',
        []
      );
      expect(formattedContext).toContain('<context_entry title="Background on Yasmin">');
      expect(formattedContext).toContain('<context_entry title="Background on Christopher">');
      expect(formattedContext).not.toContain('<context_entry title="Background on Samira">');
      expect(formattedContext).not.toContain('<context_entry title="Background on Ellena">');
      expect(newlyLoadedTitles).toContain('Background on Yasmin');
      expect(newlyLoadedTitles).toContain('Background on Christopher');
      expect(newlyLoadedTitles).not.toContain('Background on Samira');
      expect(newlyLoadedTitles).not.toContain('Background on Ellena');
    });

    it('should not load already loaded context titles', async () => {
      const alreadyLoaded = ['Background on Christopher', 'Background on Yasmin'];
      const { formattedContext, newlyLoadedTitles } = await contextService.getRelevantContext(
        'Tell me about samira',
        'christopher',
        alreadyLoaded
      );
      expect(formattedContext).toBe('');
      expect(newlyLoadedTitles).toEqual([]);
    });

    it('should inject all other available titles in an XML block on the initial turn', async () => {
      const { formattedContext } = await contextService.getRelevantContext('Hello', 'zara', []);
      expect(formattedContext).toContain('<available_context_entries>');
      expect(formattedContext).toContain('- Background on Anjali');
      expect(formattedContext).toContain('- Background on Samira');
      expect(formattedContext).toContain('- Background on Ellena');

      // Eagerly loaded background on the user and yasmin should be excluded from the directory
      expect(formattedContext).not.toContain('- Background on Zara');
      expect(formattedContext).not.toContain('- Background on Yasmin');
    });
  });
});
