jest.mock('../database/models/memory_archive.model', () => ({
  getCurrentVersion: jest.fn(),
  listCurrentVersions: jest.fn()
}));

import { getCurrentVersion, listCurrentVersions } from '../database/models/memory_archive.model';
import {
  JournalEntry,
  StagedUpdate,
  get_long_term_file,
  getStagedUpdates,
  list_long_term_files,
  read_todays_journals,
  resetNightlyToolsState,
  setTodaysJournals,
  stage_update
} from '../nightly/tools';

const mockGetCurrentVersion = getCurrentVersion as jest.Mock;
const mockListCurrentVersions = listCurrentVersions as jest.Mock;

describe('nightly/tools', () => {
  beforeEach(() => {
    mockGetCurrentVersion.mockReset();
    mockListCurrentVersions.mockReset();
    resetNightlyToolsState();
  });

  describe('resetNightlyToolsState', () => {
    it('clears prior staged updates and journals', () => {
      stage_update('people/christopher.md', 'some content', false);
      setTodaysJournals([{ conversationId: 'conv-1', userName: 'Christopher', content: 'hi' }]);

      expect(getStagedUpdates()).toHaveLength(1);
      expect(read_todays_journals()).toHaveLength(1);

      resetNightlyToolsState();

      expect(getStagedUpdates()).toEqual([]);
      expect(read_todays_journals()).toEqual([]);
    });
  });

  describe('stage_update', () => {
    it('accumulates multiple entries in order and getStagedUpdates reflects them', () => {
      const first = stage_update('people/christopher.md', 'content 1', false);
      const second = stage_update('people/samira.md', 'content 2', true);

      expect(first).toEqual({ success: true, path: 'people/christopher.md' });
      expect(second).toEqual({ success: true, path: 'people/samira.md' });

      const staged = getStagedUpdates();
      expect(staged).toEqual<StagedUpdate[]>([
        { path: 'people/christopher.md', content: 'content 1', isNew: false },
        { path: 'people/samira.md', content: 'content 2', isNew: true }
      ]);
    });

    it('returns a copy so external mutation does not affect internal state', () => {
      stage_update('people/christopher.md', 'content 1', false);

      const staged = getStagedUpdates();
      staged.push({ path: 'people/other.md', content: 'x', isNew: true });

      expect(getStagedUpdates()).toHaveLength(1);
    });

    it('rejects a traversal/unknown path without staging anything', () => {
      const result = stage_update('../secrets/passwords.md', 'evil', false);

      expect(result.success).toBe(false);
      expect(getStagedUpdates()).toHaveLength(0);
    });

    it('rejects an empty or non-string content without staging anything', () => {
      const asString = stage_update('people/alice.md', '', false);
      const asUndefined = stage_update('people/alice.md', undefined as unknown as string, false);

      expect(asString.success).toBe(false);
      expect(asUndefined.success).toBe(false);
      expect(getStagedUpdates()).toHaveLength(0);
    });
    it('stages general/topic-index.md', () => {
      const result = stage_update(
        'general/topic-index.md',
        'topics/urlaub-planung.md - Urlaubsplanung - Christopher, Samira',
        true
      );
      expect(result).toEqual({ success: true, path: 'general/topic-index.md' });
      expect(getStagedUpdates()).toEqual([
        {
          path: 'general/topic-index.md',
          content: 'topics/urlaub-planung.md - Urlaubsplanung - Christopher, Samira',
          isNew: true
        }
      ]);
    });
    it('sanitizes a topics/ slug: casing, spaces, and a traversal fragment are normalized', () => {
      const result = stage_update('topics/Urlaub Planung.md', 'Aliases: Urlaub', true);
      expect(result).toEqual({ success: true, path: 'topics/urlaub-planung.md' });
      const traversal = stage_update('topics/../secrets/x.md', 'evil', true);
      expect(traversal).toEqual({ success: true, path: 'topics/secrets-x.md' });
    });
    it('rejects a topics/ path with an empty slug', () => {
      const result = stage_update('topics/.md', 'content', true);
      expect(result.success).toBe(false);
      expect(getStagedUpdates()).toHaveLength(0);
    });
  });

  describe('get_long_term_file', () => {
    it('reads through to the mocked model and returns the content when found', async () => {
      mockGetCurrentVersion.mockResolvedValueOnce({
        id: 1,
        filePath: 'people/christopher.md',
        content: 'hello world',
        contentHash: 'abc123',
        version: 2,
        mistralDocId: null,
        syncedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z')
      });

      const result = await get_long_term_file('people/christopher.md');

      expect(mockGetCurrentVersion).toHaveBeenCalledWith('people/christopher.md');
      expect(result).toEqual({ path: 'people/christopher.md', content: 'hello world', found: true });
    });

    it('returns found:false for a missing path without throwing', async () => {
      mockGetCurrentVersion.mockResolvedValueOnce(null);

      const result = await get_long_term_file('people/unknown.md');

      expect(result).toEqual({ path: 'people/unknown.md', content: '', found: false });
    });
  });

  describe('read_todays_journals / setTodaysJournals', () => {
    it('reflects whatever setTodaysJournals was given', () => {
      const journals: JournalEntry[] = [
        { conversationId: 'conv-1', userName: 'Christopher', content: 'talked about hiking' },
        { conversationId: 'conv-2', userName: 'Samira', content: 'talked about work' }
      ];

      setTodaysJournals(journals);

      expect(read_todays_journals()).toEqual(journals);
    });

    it('returns a copy so external mutation does not affect internal state', () => {
      setTodaysJournals([{ conversationId: 'conv-1', userName: 'Christopher', content: 'hi' }]);

      const journals = read_todays_journals();
      journals.push({ conversationId: 'conv-2', userName: 'Samira', content: 'bye' });

      expect(read_todays_journals()).toHaveLength(1);
    });
  });

  describe('list_long_term_files', () => {
    it('maps model rows correctly', async () => {
      mockListCurrentVersions.mockResolvedValueOnce([
        {
          id: 1,
          filePath: 'people/christopher.md',
          content: 'hello',
          contentHash: 'hash1',
          version: 3,
          mistralDocId: null,
          syncedAt: null,
          createdAt: new Date('2026-01-01T00:00:00Z')
        },
        {
          id: 2,
          filePath: 'people/yasmin.md',
          content: 'world',
          contentHash: 'hash2',
          version: 1,
          mistralDocId: null,
          syncedAt: null,
          createdAt: new Date('2026-01-02T00:00:00Z')
        }
      ]);

      const result = await list_long_term_files();

      expect(result).toEqual([
        { path: 'people/christopher.md', contentHash: 'hash1' },
        { path: 'people/yasmin.md', contentHash: 'hash2' }
      ]);
    });
  });
});
