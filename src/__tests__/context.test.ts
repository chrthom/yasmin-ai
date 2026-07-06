import { contextService } from '../services/context.service';

describe('Context Service', () => {
  describe('getRelevantContext', () => {
    it('should retrieve profile on the sender and yasmin and format as XML', async () => {
      const { formattedContext, newlyLoadedTitles } = await contextService.getRelevantContext(
        'Hello',
        'zara',
        []
      );
      expect(formattedContext).toContain('<context_entry title="Profile of Yasmin">');
      expect(formattedContext).toContain('<context_entry title="Profile of Zara">');
      expect(formattedContext).toContain("Zara is Yasmin's older sister");
      expect(newlyLoadedTitles).toContain('Profile of Yasmin');
      expect(newlyLoadedTitles).toContain('Profile of Zara');
      expect(newlyLoadedTitles).toContain('Family notes');
    });

    it('should retrieve only eager-loaded entries (Profile, Family notes, Yasmin) even if other people are mentioned', async () => {
      const { formattedContext, newlyLoadedTitles } = await contextService.getRelevantContext(
        'Tell me about samira and ellena',
        'christopher',
        []
      );
      expect(formattedContext).toContain('<context_entry title="Profile of Yasmin">');
      expect(formattedContext).toContain('<context_entry title="Profile of Christopher">');
      expect(formattedContext).toContain('<context_entry title="Family notes">');
      expect(formattedContext).not.toContain('<context_entry title="Profile of Samira">');
      expect(formattedContext).not.toContain('<context_entry title="Profile of Ellena">');
      expect(newlyLoadedTitles).toContain('Profile of Yasmin');
      expect(newlyLoadedTitles).toContain('Profile of Christopher');
      expect(newlyLoadedTitles).toContain('Family notes');
      expect(newlyLoadedTitles).not.toContain('Profile of Samira');
      expect(newlyLoadedTitles).not.toContain('Profile of Ellena');
    });

    it('should not reload already loaded context titles', async () => {
      const alreadyLoaded = ['Profile of Christopher', 'Profile of Yasmin', 'Family notes'];
      const { formattedContext, newlyLoadedTitles } = await contextService.getRelevantContext(
        'Tell me about samira',
        'christopher',
        alreadyLoaded
      );
      expect(formattedContext).toBe('\n\nYou are talking to christopher.');
      expect(newlyLoadedTitles).toEqual([]);
    });

    it('should inject all other available titles in an XML block on the initial turn', async () => {
      const { formattedContext } = await contextService.getRelevantContext('Hello', 'zara', []);
      expect(formattedContext).toContain('<available_context_entries>');
      expect(formattedContext).toContain('- Profile of Anjali');
      expect(formattedContext).toContain('- Profile of Samira');
      expect(formattedContext).toContain('- Profile of Ellena');
      expect(formattedContext).toContain('- Journal with Anjali');

      // Session entries are no longer eagerly loaded, so they now appear in the directory
      expect(formattedContext).toContain('- Session with Zara');

      // Eagerly loaded entries should be excluded from the directory
      expect(formattedContext).not.toContain('- Profile of Zara');
      expect(formattedContext).not.toContain('- Profile of Yasmin');
      expect(formattedContext).not.toContain('- Family notes');
    });
  });
});
