jest.mock('../database/connection', () => ({
  executeQuery: jest.fn()
}));

import { executeQuery } from '../database/connection';
import {
  claimNoteDelivery,
  clearPendingNotes,
  getPendingNotesMaxId,
  getUnconsolidatedNotes,
  getUndeliveredNotesForUser,
  insertPendingNote,
  releaseNoteDelivery
} from '../database/models/pending_notes.model';

const mockExecuteQuery = executeQuery as jest.Mock;

describe('pending_notes.model', () => {
  beforeEach(() => {
    mockExecuteQuery.mockReset();
  });

  describe('insertPendingNote', () => {
    it('inserts with the current timestamp and returns the new id', async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ insertId: 7 }]);
      const id = await insertPendingNote('christopher', 'zara', 'Be home by 6 pm');
      expect(id).toBe(7);
      const [sql, params] = mockExecuteQuery.mock.calls[0];
      expect(sql).toMatch(/^INSERT INTO pending_notes/);
      expect(params[0]).toBe('christopher');
      expect(params[1]).toBe('zara');
      expect(params[2]).toBe('Be home by 6 pm');
      expect(params[3]).toBeInstanceOf(Date);
    });

    it('passes NULL as recipient for an "everyone" note', async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ insertId: 8 }]);
      await insertPendingNote('christopher', null, 'Family movie night');
      const [sql, params] = mockExecuteQuery.mock.calls[0];
      expect(sql).toMatch(/^INSERT INTO pending_notes/);
      expect(params[1]).toBeNull();
    });
  });

  describe('getUndeliveredNotesForUser', () => {
    it('compares delivered_to entries case-insensitively (canonical lowercase parameter)', async () => {
      mockExecuteQuery.mockResolvedValueOnce([[]]);
      await getUndeliveredNotesForUser('Zara');
      const [sql, params] = mockExecuteQuery.mock.calls[0];
      expect(sql).toContain('JSON_QUOTE(?)');
      // The JSON_CONTAINS comparison gets the lowercased form; the *_ci column comparisons
      // keep the raw username.
      expect(params).toEqual(['Zara', 'Zara', 'zara']);
    });

    it('selects individual and everyone-notes excluding the sender and orders chronologically', async () => {
      mockExecuteQuery.mockResolvedValueOnce([
        [
          { id: 1, from_username: 'christopher', content: 'note a' },
          { id: 2, from_username: 'anjali', content: 'note b' }
        ]
      ]);
      const notes = await getUndeliveredNotesForUser('zara');
      expect(notes).toEqual([
        { id: 1, fromUsername: 'christopher', content: 'note a' },
        { id: 2, fromUsername: 'anjali', content: 'note b' }
      ]);
      const [sql, params] = mockExecuteQuery.mock.calls[0];
      expect(sql).toContain('from_username != ?');
      expect(sql).toContain('to_username = ?');
      expect(sql).toContain('to_username IS NULL');
      expect(sql).toContain('ORDER BY created_at, id');
      expect(params).toEqual(['zara', 'zara', 'zara']);
    });
  });

  describe('claimNoteDelivery', () => {
    it('claims an individually addressed note atomically (affectedRows 1)', async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ affectedRows: 1 }]);
      const claimed = await claimNoteDelivery(5, 'zara');
      expect(claimed).toBe(true);
      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockExecuteQuery.mock.calls[0];
      expect(sql).toContain('to_username = ?');
      expect(sql).toContain('delivered_at IS NULL');
      expect(params[1]).toBe(5);
      expect(params[2]).toBe('zara');
    });

    it('returns false when the individual note was already delivered (race lost, affectedRows 0)', async () => {
      mockExecuteQuery
        .mockResolvedValueOnce([{ affectedRows: 0 }])
        .mockResolvedValueOnce([{ affectedRows: 0 }]);
      const claimed = await claimNoteDelivery(5, 'zara');
      expect(claimed).toBe(false);
      expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
    });

    it('normalizes the username casing for everyone-notes (same user, two casings, one delivery)', async () => {
      // First delivery as "Zara": stored lowercased in delivered_to.
      mockExecuteQuery
        .mockResolvedValueOnce([{ affectedRows: 0 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);
      expect(await claimNoteDelivery(9, 'Zara')).toBe(true);
      const appendParams = mockExecuteQuery.mock.calls[1][1];
      expect(appendParams).toEqual(['zara', 9, 'zara']);
      // Second claim for the same user as "zara": the NOT JSON_CONTAINS guard matches the
      // lowercased stored entry, so the claim loses the race and returns false.
      mockExecuteQuery
        .mockResolvedValueOnce([{ affectedRows: 0 }])
        .mockResolvedValueOnce([{ affectedRows: 0 }]);
      expect(await claimNoteDelivery(9, 'zara')).toBe(false);
    });

    it('claims an everyone-note by appending the recipient to delivered_to', async () => {
      mockExecuteQuery
        .mockResolvedValueOnce([{ affectedRows: 0 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);
      const claimed = await claimNoteDelivery(9, 'samira');
      expect(claimed).toBe(true);
      const [sql, params] = mockExecuteQuery.mock.calls[1];
      expect(sql).toContain('JSON_ARRAY_APPEND');
      expect(sql).toContain('to_username IS NULL');
      expect(sql).toContain('NOT JSON_CONTAINS');
      expect(params).toEqual(['samira', 9, 'samira']);
    });

    it('returns false when the recipient is already in delivered_to (exactly-once per person)', async () => {
      mockExecuteQuery
        .mockResolvedValueOnce([{ affectedRows: 0 }])
        .mockResolvedValueOnce([{ affectedRows: 0 }]);
      const claimed = await claimNoteDelivery(9, 'samira');
      expect(claimed).toBe(false);
    });
  });

  describe('getPendingNotesMaxId', () => {
    it('returns the highest note id over all notes (0 when the table is empty)', async () => {
      mockExecuteQuery.mockResolvedValueOnce([[{ max_id: 17 }]]);
      const maxId = await getPendingNotesMaxId();
      expect(maxId).toBe(17);
      const [sql] = mockExecuteQuery.mock.calls[0];
      expect(sql).toContain('COALESCE(MAX(id), 0)');
    });
  });

  describe('getUnconsolidatedNotes', () => {
    it('lists only notes with delivered_at still NULL up to the snapshot id, and maps snake_case rows', async () => {
      mockExecuteQuery.mockResolvedValueOnce([
        [
          {
            id: 3,
            from_username: 'zara',
            to_username: null,
            content: 'everyone note',
            created_at: new Date('2025-01-01T10:00:00Z')
          }
        ]
      ]);
      const notes = await getUnconsolidatedNotes(17);
      expect(notes).toEqual([
        {
          id: 3,
          fromUsername: 'zara',
          toUsername: null,
          content: 'everyone note',
          createdAt: new Date('2025-01-01T10:00:00Z')
        }
      ]);
      const [sql, params] = mockExecuteQuery.mock.calls[0];
      expect(sql).toContain('delivered_at IS NULL');
      expect(sql).toContain('id <= ?');
      expect(params).toEqual([17]);
    });
  });

  describe('releaseNoteDelivery', () => {
    it('un-claims an individually delivered note (delivered_at back to NULL)', async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ affectedRows: 1 }]);
      await releaseNoteDelivery(5, 'zara');
      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockExecuteQuery.mock.calls[0];
      expect(sql).toContain('SET delivered_at = NULL');
      expect(sql).toContain('to_username = ?');
      expect(params).toEqual([5, 'zara']);
    });

    it('removes the recipient from an everyone-note delivered_to array', async () => {
      mockExecuteQuery
        .mockResolvedValueOnce([{ affectedRows: 0 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);
      await releaseNoteDelivery(9, 'samira');
      const [sql, params] = mockExecuteQuery.mock.calls[1];
      expect(sql).toContain('JSON_REMOVE');
      expect(sql).toContain("JSON_SEARCH(delivered_to, 'one', ?)");
      expect(params).toEqual(['samira', 9, 'samira']);
    });

    it('is idempotent when there is nothing to release', async () => {
      mockExecuteQuery
        .mockResolvedValueOnce([{ affectedRows: 0 }])
        .mockResolvedValueOnce([{ affectedRows: 0 }]);
      await expect(releaseNoteDelivery(9, 'samira')).resolves.toBeUndefined();
    });
  });

  describe('clearPendingNotes', () => {
    it('empties only notes up to the snapshot max id (never younger, concurrently inserted ones)', async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ affectedRows: 4 }]);
      await clearPendingNotes(17);
      const [sql, params] = mockExecuteQuery.mock.calls[0];
      expect(sql).toBe('DELETE FROM pending_notes WHERE id <= ?');
      expect(params).toEqual([17]);
    });
  });
});
