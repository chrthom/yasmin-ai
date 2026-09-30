jest.mock('../database/connection', () => ({
  executeQuery: jest.fn()
}));

import { executeQuery } from '../database/connection';
import {
  computeContentHash,
  getCurrentVersion,
  insertNextVersion,
  listCurrentVersions,
  listUnsynced,
  markSynced,
  pruneOldVersions
} from '../database/models/memory_archive.model';

const mockExecuteQuery = executeQuery as jest.Mock;

function dbRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 1,
    file_path: 'people/christopher.md',
    content: 'hello world',
    content_hash: computeContentHash('hello world'),
    version: 1,
    mistral_doc_id: null,
    synced_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides
  };
}

describe('memory_archive.model', () => {
  beforeEach(() => {
    mockExecuteQuery.mockReset();
  });

  describe('computeContentHash', () => {
    it('produces a stable 64-char hex SHA-256 digest', () => {
      const hash = computeContentHash('hello world');
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(computeContentHash('hello world')).toBe(hash);
      expect(computeContentHash('different')).not.toBe(hash);
    });
  });

  describe('getCurrentVersion', () => {
    it('returns null when no row exists', async () => {
      mockExecuteQuery.mockResolvedValueOnce([[]]);
      const result = await getCurrentVersion('people/christopher.md');
      expect(result).toBeNull();
    });

    it('returns the mapped highest-version row', async () => {
      mockExecuteQuery.mockResolvedValueOnce([[dbRow({ version: 3 })]]);
      const result = await getCurrentVersion('people/christopher.md');
      expect(result).toEqual(
        expect.objectContaining({
          filePath: 'people/christopher.md',
          version: 3,
          contentHash: expect.any(String)
        })
      );
    });
  });

  describe('insertNextVersion', () => {
    it('creates version n+1 when content differs from the current version', async () => {
      const current = dbRow({
        version: 2,
        content: 'old content',
        content_hash: computeContentHash('old content')
      });
      const newRow = dbRow({
        id: 2,
        version: 3,
        content: 'new content',
        content_hash: computeContentHash('new content')
      });

      mockExecuteQuery
        .mockResolvedValueOnce([[current]]) // getCurrentVersion
        .mockResolvedValueOnce([{ insertId: 2, affectedRows: 1 }]) // INSERT
        .mockResolvedValueOnce([[newRow]]); // re-select

      const { row, created } = await insertNextVersion('people/christopher.md', 'new content');

      expect(created).toBe(true);
      expect(row.version).toBe(3);
      expect(row.content).toBe('new content');

      const insertCall = mockExecuteQuery.mock.calls[1];
      expect(insertCall[0]).toMatch(/^INSERT INTO memory_archive/);
      expect(insertCall[1]).toEqual([
        'people/christopher.md',
        'new content',
        computeContentHash('new content'),
        3
      ]);
    });

    it('returns created:false with the same version/content when the hash is unchanged', async () => {
      const content = 'unchanged content';
      const current = dbRow({ version: 5, content, content_hash: computeContentHash(content) });

      mockExecuteQuery.mockResolvedValueOnce([[current]]); // getCurrentVersion only

      const { row, created } = await insertNextVersion('people/christopher.md', content);

      expect(created).toBe(false);
      expect(row.version).toBe(5);
      expect(row.content).toBe(content);

      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
      const insertCalls = mockExecuteQuery.mock.calls.filter(call =>
        String(call[0]).trim().toUpperCase().startsWith('INSERT')
      );
      expect(insertCalls).toHaveLength(0);
    });

    it('creates version 1 when no prior version exists', async () => {
      const newRow = dbRow({ id: 10, version: 1 });

      mockExecuteQuery
        .mockResolvedValueOnce([[]]) // getCurrentVersion -> none
        .mockResolvedValueOnce([{ insertId: 10, affectedRows: 1 }]) // INSERT
        .mockResolvedValueOnce([[newRow]]); // re-select

      const { row, created } = await insertNextVersion('people/christopher.md', 'hello world');

      expect(created).toBe(true);
      expect(row.version).toBe(1);
    });
  });

  describe('listCurrentVersions', () => {
    it('returns the MAX(version) row per file_path', async () => {
      const rows = [
        dbRow({ id: 1, file_path: 'people/christopher.md', version: 3 }),
        dbRow({ id: 2, file_path: 'people/yasmin.md', version: 1 })
      ];
      mockExecuteQuery.mockResolvedValueOnce([rows]);

      const result = await listCurrentVersions();

      expect(result).toHaveLength(2);
      expect(result[0].filePath).toBe('people/christopher.md');
      expect(result[0].version).toBe(3);
      expect(result[1].filePath).toBe('people/yasmin.md');
      expect(result[1].version).toBe(1);

      const [query] = mockExecuteQuery.mock.calls[0];
      expect(query).toMatch(/MAX\(version\)/);
    });
  });

  describe('listUnsynced', () => {
    it('filters current versions to those with synced_at IS NULL in a single query', async () => {
      const rows = [dbRow({ id: 3, file_path: 'people/samira.md', version: 2, synced_at: null })];
      mockExecuteQuery.mockResolvedValueOnce([rows]);

      const result = await listUnsynced();

      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
      const [query] = mockExecuteQuery.mock.calls[0];
      expect(query).toMatch(/synced_at IS NULL/);
      expect(result).toHaveLength(1);
      expect(result[0].syncedAt).toBeNull();
    });
  });

  describe('markSynced', () => {
    it('issues an update that sets synced_at and mistral_doc_id', async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ affectedRows: 1 }]);

      await markSynced(7, 'doc-123');

      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
      const [query, params] = mockExecuteQuery.mock.calls[0];
      expect(query).toMatch(/UPDATE memory_archive SET mistral_doc_id = \?, synced_at = NOW\(\)/);
      expect(params).toEqual(['doc-123', 7]);
    });
  });

  describe('pruneOldVersions', () => {
    it('keeps the last N versions and deletes the rest for a single path', async () => {
      mockExecuteQuery
        .mockResolvedValueOnce([[{ file_path: 'people/christopher.md', version_count: 5 }]]) // group by
        .mockResolvedValueOnce([
          [{ version: 5 }, { version: 4 }, { version: 3 }, { version: 2 }, { version: 1 }]
        ]) // versions desc
        .mockResolvedValueOnce([{ affectedRows: 3 }]); // delete

      const deleted = await pruneOldVersions(2, 1);

      expect(deleted).toBe(3);
      const deleteCall = mockExecuteQuery.mock.calls[2];
      expect(deleteCall[0]).toMatch(/^DELETE FROM memory_archive/);
      expect(deleteCall[1]).toEqual(['people/christopher.md', 3, 2, 1]);
    });

    it('never drops a path below keepMin even if keepN is smaller', async () => {
      mockExecuteQuery.mockResolvedValueOnce([[{ file_path: 'people/christopher.md', version_count: 4 }]]);

      const deleted = await pruneOldVersions(1, 4);

      expect(deleted).toBe(0);
      // Only the initial group-by query should run; no per-path version/delete queries.
      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
    });

    it('skips paths that are already within the keep threshold', async () => {
      mockExecuteQuery.mockResolvedValueOnce([[{ file_path: 'people/yasmin.md', version_count: 1 }]]);

      const deleted = await pruneOldVersions(5, 1);

      expect(deleted).toBe(0);
      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
    });
  });
});
