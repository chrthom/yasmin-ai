jest.mock('../database/connection', () => ({
  executeQuery: jest.fn()
}));

import { executeQuery } from '../database/connection';
import {
  claimNoteDelivery,
  clearPendingNotes,
  getUnconsolidatedNotes,
  getUndeliveredNotesForUser,
  insertPendingNote
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

  describe('getUnconsolidatedNotes', () => {
    it('lists only notes with delivered_at still NULL and maps snake_case rows', async () => {
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
      const notes = await getUnconsolidatedNotes();
      expect(notes).toEqual([
        {
          id: 3,
          fromUsername: 'zara',
          toUsername: null,
          content: 'everyone note',
          createdAt: new Date('2025-01-01T10:00:00Z')
        }
      ]);
      const [sql] = mockExecuteQuery.mock.calls[0];
      expect(sql).toContain('delivered_at IS NULL');
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
