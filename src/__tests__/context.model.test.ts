jest.mock('../database/connection', () => ({
  executeQuery: jest.fn()
}));

import { executeQuery } from '../database/connection';
import { upsertContextEntry } from '../database/models/context.model';

const mockExecuteQuery = executeQuery as jest.Mock;

describe('context.model', () => {
  beforeEach(() => {
    mockExecuteQuery.mockReset();
  });

  describe('upsertContextEntry', () => {
    it('inserts a new entry when none exists yet', async () => {
      mockExecuteQuery
        .mockResolvedValueOnce([[]]) // getContentByTitleFromDb -> no rows
        .mockResolvedValueOnce([{ insertId: 1, affectedRows: 1 }]); // INSERT

      const result = await upsertContextEntry('Profile of Christopher', 'Some content');

      expect(result).toBe('inserted');
      expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
      const insertCall = mockExecuteQuery.mock.calls[1];
      expect(insertCall[0]).toMatch(/^INSERT INTO context_entries/);
      expect(insertCall[1]).toEqual(['Profile of Christopher', 'Some content']);
    });

    it('updates the existing entry when a row already exists', async () => {
      mockExecuteQuery
        .mockResolvedValueOnce([[{ content: 'Old content' }]]) // getContentByTitleFromDb -> existing row
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE

      const result = await upsertContextEntry('Profile of Christopher', 'New content');

      expect(result).toBe('updated');
      expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
      const updateCall = mockExecuteQuery.mock.calls[1];
      expect(updateCall[0]).toMatch(/^UPDATE context_entries SET/);
      expect(updateCall[1]).toEqual(['New content', 'Profile of Christopher']);
    });

    it('throws instead of reporting updated when the UPDATE affects no rows', async () => {
      mockExecuteQuery
        .mockResolvedValueOnce([[{ content: 'Old content' }]]) // getContentByTitleFromDb -> existing row
        .mockResolvedValueOnce([{ affectedRows: 0 }]); // UPDATE affected nothing

      await expect(upsertContextEntry('Profile of Christopher', 'New content')).rejects.toThrow(
        /failed \(0 rows affected\)/
      );
    });
  });
});
