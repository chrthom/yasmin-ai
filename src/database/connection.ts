import { createPool, Pool, PoolConnection } from 'mysql2/promise';
import { config } from '../config';

let dbPool: Pool | null = null;

/**
 * Creates a connection pool to the MariaDB database
 *
 * @returns The (lazily created, process-wide) database connection pool.
 */
export function getDatabasePool(): Pool {
  if (dbPool) {
    return dbPool;
  }

  dbPool = createPool({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.name,
    charset: 'utf8mb4',
    timezone: '+00:00',
    connectionLimit: 10,
    queueLimit: 0,
    idleTimeout: 60000,
    // Bounds a single connection attempt so an unreachable host fails fast instead of hanging past
    // any caller's own timeout (e.g. a test suite's default test timeout).
    connectTimeout: 5000
  });

  console.log('Successfully created MariaDB connection pool');
  return dbPool;
}

/**
 * Executes a query with automatic retry on connection timeouts
 *
 * @param query SQL query to execute.
 * @param params Query parameters.
 * @param noRetry Whether to disable retry logic.
 * @returns The raw query result.
 * @throws The underlying error when the query fails (after one retry on connection timeouts).
 */
export async function executeQuery(
  query: string,
  params: any[] = [],
  noRetry: boolean = false
): Promise<any> {
  const pool = getDatabasePool();
  let connection: PoolConnection | undefined;

  try {
    connection = await pool.getConnection();
    return await connection.execute(query, params);
  } catch (error: any) {
    console.warn(`WARN: DB error ${error}`);

    // Retry on connection timeout
    if (error.code === 'ER_GET_CONNECTION_TIMEOUT' || error.code === 'ETIMEDOUT') {
      if (!noRetry) {
        console.log('Retrying query due to connection timeout...');
        return await executeQuery(query, params, true);
      }
    }

    throw error;
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

/**
 * Closes the database connection pool
 *
 * @throws The underlying error when the pool cannot be closed.
 */
export async function closeDatabasePool(): Promise<void> {
  if (dbPool) {
    await dbPool.end();
    dbPool = null;
    console.log('Database connection pool closed');
  }
}
