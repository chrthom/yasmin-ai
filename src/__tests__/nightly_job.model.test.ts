jest.mock('../database/connection', () => ({
  executeQuery: jest.fn()
}));

import { executeQuery } from '../database/connection';
import {
  acquireLock,
  createJobLog,
  getWatermark,
  setWatermark,
  pruneOldJobLogs,
  releaseLock,
  updateJobLog
} from '../database/models/nightly_job.model';

const mockExecuteQuery = executeQuery as jest.Mock;

describe('nightly_job.model', () => {
  beforeEach(() => {
    mockExecuteQuery.mockReset();
  });

  describe('createJobLog', () => {
    it('inserts a running row and returns the insertId', async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ insertId: 42, affectedRows: 1 }]);

      const id = await createJobLog();

      expect(id).toBe(42);
      const [query] = mockExecuteQuery.mock.calls[0];
      expect(query).toMatch(/INSERT INTO nightly_job_log/);
      expect(query).toMatch(/running/);
    });
  });

  describe('updateJobLog', () => {
    it('builds a dynamic UPDATE with only the provided fields, JSON-stringifying id arrays', async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ affectedRows: 1 }]);

      await updateJobLog(42, {
        status: 'completed',
        processedConversationIds: ['conv-1', 'conv-2'],
        skippedConversationIds: [],
        filesUpdated: 3,
        completedAt: true
      });

      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
      const [query, params] = mockExecuteQuery.mock.calls[0];

      expect(query).toMatch(/UPDATE nightly_job_log SET/);
      expect(query).toMatch(/status = \?/);
      expect(query).toMatch(/processed_conversation_ids = \?/);
      expect(query).toMatch(/skipped_conversation_ids = \?/);
      expect(query).toMatch(/files_updated = \?/);
      expect(query).toMatch(/completed_at = NOW\(\)/);
      expect(query).toMatch(/WHERE id = \?/);

      expect(params).toEqual(['completed', JSON.stringify(['conv-1', 'conv-2']), JSON.stringify([]), 3, 42]);
    });

    it('is a no-op when the patch has no relevant keys', async () => {
      await updateJobLog(42, {});
      expect(mockExecuteQuery).not.toHaveBeenCalled();
    });
  });

  describe('getWatermark', () => {
    it('reads the snapshot time from the dedicated nightly_watermark singleton', async () => {
      const watermark = new Date('2026-07-01T02:00:00Z');
      mockExecuteQuery.mockResolvedValueOnce([[{ watermark }]]);

      const result = await getWatermark();

      expect(result).toBe(watermark);
      const [query] = mockExecuteQuery.mock.calls[0];
      expect(query).toMatch(/FROM nightly_watermark WHERE id = 1/);
    });

    it('returns null when no watermark row exists yet', async () => {
      mockExecuteQuery.mockResolvedValueOnce([[{ watermark: null }]]);

      const result = await getWatermark();

      expect(result).toBeNull();
    });
  });

  describe('setWatermark', () => {
    it('upserts the singleton row with an ON DUPLICATE KEY UPDATE', async () => {
      mockExecuteQuery.mockResolvedValueOnce([[{ affectedRows: 1 }]]);
      const snapshotAt = new Date('2026-07-01T02:00:00Z');

      await setWatermark(snapshotAt);

      const [query, params] = mockExecuteQuery.mock.calls[0];
      expect(query).toMatch(/INSERT INTO nightly_watermark/);
      expect(query).toMatch(/ON DUPLICATE KEY UPDATE/);
      expect(params).toEqual([snapshotAt]);
    });
  });

  describe('pruneOldJobLogs', () => {
    it('deletes old completed rows and returns the affected count', async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ affectedRows: 5 }]);

      const deleted = await pruneOldJobLogs(30);

      expect(deleted).toBe(5);
      const [query, params] = mockExecuteQuery.mock.calls[0];
      expect(query).toMatch(/completed_at IS NOT NULL/);
      expect(query).toMatch(/INTERVAL \? DAY/);
      expect(params).toEqual([30]);
    });
  });

  describe('acquireLock', () => {
    it('succeeds with a single INSERT when the lock is free', async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ insertId: 0, affectedRows: 1 }]);

      const acquired = await acquireLock('nightly', 'host:123', 60000);

      expect(acquired).toBe(true);
      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
      const [query] = mockExecuteQuery.mock.calls[0];
      expect(query).toMatch(/INSERT INTO processing_lock/);
    });

    it('returns false without issuing an UPDATE when the existing lock is fresh', async () => {
      const dupError: any = new Error('Duplicate entry');
      dupError.code = 'ER_DUP_ENTRY';
      mockExecuteQuery.mockRejectedValueOnce(dupError);
      mockExecuteQuery.mockResolvedValueOnce([[{ acquired_at: new Date(Date.now() - 1000) }]]);

      const acquired = await acquireLock('nightly', 'host:123', 60000);

      expect(acquired).toBe(false);
      expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
      const calls = mockExecuteQuery.mock.calls.map(call => String(call[0]));
      expect(calls.some(q => q.startsWith('UPDATE'))).toBe(false);
    });

    it('steals a stale lock by issuing a compare-and-swap UPDATE and returns true', async () => {
      const staleAcquiredAt = new Date(Date.now() - 120000);
      const dupError: any = new Error('Duplicate entry');
      dupError.code = 'ER_DUP_ENTRY';
      mockExecuteQuery.mockRejectedValueOnce(dupError);
      mockExecuteQuery.mockResolvedValueOnce([[{ acquired_at: staleAcquiredAt }]]);
      mockExecuteQuery.mockResolvedValueOnce([{ affectedRows: 1 }]);

      const acquired = await acquireLock('nightly', 'host:456', 60000);

      expect(acquired).toBe(true);
      expect(mockExecuteQuery).toHaveBeenCalledTimes(3);
      const [updateQuery, updateParams] = mockExecuteQuery.mock.calls[2];
      expect(updateQuery).toMatch(
        /^UPDATE processing_lock SET acquired_at = NOW\(\), owner = \? WHERE lock_name = \? AND acquired_at = \?/
      );
      expect(updateParams).toEqual(['host:456', 'nightly', staleAcquiredAt]);
    });

    it('loses the steal race when a concurrent caller already stole the stale lock (CAS affectedRows 0)', async () => {
      const dupError: any = new Error('Duplicate entry');
      dupError.code = 'ER_DUP_ENTRY';
      mockExecuteQuery.mockRejectedValueOnce(dupError);
      mockExecuteQuery.mockResolvedValueOnce([[{ acquired_at: new Date(Date.now() - 120000) }]]);
      mockExecuteQuery.mockResolvedValueOnce([{ affectedRows: 0 }]);

      const acquired = await acquireLock('nightly', 'host:456', 60000);

      expect(acquired).toBe(false);
    });

    it('rethrows non-duplicate-key errors', async () => {
      const otherError: any = new Error('connection refused');
      otherError.code = 'ECONNREFUSED';
      mockExecuteQuery.mockRejectedValueOnce(otherError);

      await expect(acquireLock('nightly', 'host:123', 60000)).rejects.toThrow('connection refused');
    });
  });

  describe('releaseLock', () => {
    it('issues an owner-scoped DELETE for the given lock name', async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ affectedRows: 1 }]);

      await releaseLock('nightly', 'host:123');

      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
      const [query, params] = mockExecuteQuery.mock.calls[0];
      expect(query).toMatch(/^DELETE FROM processing_lock WHERE lock_name = \? AND owner = \?/);
      expect(params).toEqual(['nightly', 'host:123']);
    });
  });
});
