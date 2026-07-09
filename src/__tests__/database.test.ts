import { getDatabasePool, executeQuery, closeDatabasePool } from '../database/connection';

// This suite opens a real TCP connection to the configured MariaDB host -- there is no reachable
// database in a default dev/CI sandbox, and connection.ts's connectTimeout (5s) is already close to
// jest's default per-test timeout, so a real attempt reliably either times out mid-test or leaves the
// pool tearing down a still-in-flight connection in afterAll, failing the whole suite to run. Gate it
// behind the same USE_REAL_DB opt-in the rest of the codebase already uses for real-DB integration
// checks (see src/database/db_proxy.ts), and run it explicitly against a real/reachable DB when needed.
const describeIfRealDb = process.env['USE_REAL_DB'] === 'true' ? describe : describe.skip;

describeIfRealDb('Database Connection', () => {
  beforeAll(() => {
    // Initialize the database pool
    getDatabasePool();
  });

  afterAll(async () => {
    // Close the database pool
    await closeDatabasePool();
  });

  test('should be able to execute a simple query', async () => {
    const [rows] = await executeQuery('SELECT 1 as test');
    expect(rows).toEqual([{ test: 1 }]);
  });

  test('should be able to handle query errors gracefully', async () => {
    await expect(executeQuery('INVALID SQL STATEMENT')).rejects.toBeDefined();
  });
});
