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
    it('reports inserted when the atomic statement inserts a fresh row (affectedRows 1)', async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ affectedRows: 1 }]);

      const result = await upsertContextEntry('Profile of Christopher', 'Some content');

      expect(result).toBe('inserted');
      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockExecuteQuery.mock.calls[0];
      expect(sql).toMatch(/^INSERT INTO context_entries/i);
      expect(sql).toMatch(/ON DUPLICATE KEY UPDATE/i);
      expect(params).toEqual(['Profile of Christopher', 'Some content']);
    });

    it('reports updated when a pre-existing row was refreshed (affectedRows 2)', async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ affectedRows: 2 }]);

      const result = await upsertContextEntry('Profile of Christopher', 'New content');

      expect(result).toBe('updated');
      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
    });

    it('reports updated when a pre-existing row held identical content (affectedRows 0)', async () => {
      mockExecuteQuery.mockResolvedValueOnce([{ affectedRows: 0 }]);

      const result = await upsertContextEntry('Profile of Christopher', 'Same content');

      expect(result).toBe('updated');
      expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
    });
  });
});
