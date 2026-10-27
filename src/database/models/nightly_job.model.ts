import { executeQuery } from '../connection';

/** Lifecycle status of a nightly job-log row. */
export type NightlyJobStatus = 'running' | 'completed' | 'partial' | 'failed';

/** One nightly_job_log row: the run's resumable state, phase progress, and counters. */
export interface NightlyJobLog {
  id: number;
  startedAt: Date;
  completedAt: Date | null;
  status: NightlyJobStatus;
  lastCompletedPhase: string | null;
  processedConversationIds: string[];
  skippedConversationIds: string[];
  errorMessage: string | null;
  conversationsProcessed: number;
  filesUpdated: number;
  filesCreated: number;
}

/** Partial update for one nightly_job_log row; only the provided fields are written. */
export interface NightlyJobLogPatch {
  status?: NightlyJobStatus;
  lastCompletedPhase?: string;
  processedConversationIds?: string[];
  skippedConversationIds?: string[];
  errorMessage?: string;
  conversationsProcessed?: number;
  filesUpdated?: number;
  filesCreated?: number;
  /**
   * true: sets completed_at = NOW() (current wall-clock time).
   * Date: sets completed_at to that specific instant -- used by the nightly pipeline to record when
   * Phase 1's conversation-listing snapshot was actually taken, not whenever the whole job (which can
   * run for several more minutes across phases 2-9) eventually finishes. See pipeline.ts's
   * `collectedAt` for why this distinction matters for the next run's watermark.
   */
  completedAt?: boolean | Date;
}

/**
 * Creates a new nightly_job_log row with status 'running'
 *
 * @returns The insertId of the new row.
 * @throws The underlying error when the insert fails.
 */
export async function createJobLog(): Promise<number> {
  try {
    const [result]: any = await executeQuery("INSERT INTO nightly_job_log (status) VALUES ('running')");
    return result.insertId;
  } catch (error) {
    console.error('Error creating nightly_job_log entry:', error);
    throw error;
  }
}

/**
 * Updates a nightly_job_log row with only the provided fields
 *
 * @param id The job row's id.
 * @param patch The fields to write.
 * @throws The underlying error when the update fails.
 */
export async function updateJobLog(id: number, patch: NightlyJobLogPatch): Promise<void> {
  try {
    const fields: string[] = [];
    const values: any[] = [];

    if (patch.status !== undefined) {
      fields.push('status = ?');
      values.push(patch.status);
    }

    if (patch.lastCompletedPhase !== undefined) {
      fields.push('last_completed_phase = ?');
      values.push(patch.lastCompletedPhase);
    }

    if (patch.processedConversationIds !== undefined) {
      fields.push('processed_conversation_ids = ?');
      values.push(JSON.stringify(patch.processedConversationIds));
    }

    if (patch.skippedConversationIds !== undefined) {
      fields.push('skipped_conversation_ids = ?');
      values.push(JSON.stringify(patch.skippedConversationIds));
    }

    if (patch.errorMessage !== undefined) {
      fields.push('error_message = ?');
      values.push(patch.errorMessage);
    }

    if (patch.conversationsProcessed !== undefined) {
      fields.push('conversations_processed = ?');
      values.push(patch.conversationsProcessed);
    }

    if (patch.filesUpdated !== undefined) {
      fields.push('files_updated = ?');
      values.push(patch.filesUpdated);
    }

    if (patch.filesCreated !== undefined) {
      fields.push('files_created = ?');
      values.push(patch.filesCreated);
    }

    if (patch.completedAt === true) {
      fields.push('completed_at = NOW()');
    } else if (patch.completedAt instanceof Date) {
      fields.push('completed_at = ?');
      values.push(patch.completedAt);
    }

    if (fields.length === 0) {
      return;
    }

    values.push(id);
    const query = `UPDATE nightly_job_log SET ${fields.join(', ')} WHERE id = ?`;
    await executeQuery(query, values);
  } catch (error) {
    console.error(`Error updating nightly_job_log id ${id}:`, error);
    throw error;
  }
}

/**
 * Returns the snapshot time of the most recently fully-completed job, or null if none.
 *
 * Read from the dedicated nightly_watermark singleton -- NOT from nightly_job_log -- so a pruning of
 * old completed rows (pruneOldJobLogs) can never erase the watermark and trigger a silent full
 * reprocess of the previous 24h. The watermark only advances on a fully completed run.
 *
 * @returns The snapshot time of the most recently fully-completed job, or null if none.
 * @throws The underlying error when the query fails.
 */
export async function getWatermark(): Promise<Date | null> {
  try {
    const [rows]: any = await executeQuery(
      'SELECT snapshot_at AS watermark FROM nightly_watermark WHERE id = 1'
    );
    return rows[0]?.watermark ?? null;
  } catch (error) {
    console.error('Error retrieving nightly job watermark:', error);
    throw error;
  }
}

/**
 * Records the Phase-1 listing snapshot time of a fully-completed run as the durable watermark.
 * Idempotent upsert on the singleton row.
 *
 * @param snapshotAt The instant the completed run's conversation batch was snapshotted.
 * @throws The underlying error when the upsert fails.
 */
export async function setWatermark(snapshotAt: Date): Promise<void> {
  try {
    await executeQuery(
      'INSERT INTO nightly_watermark (id, snapshot_at) VALUES (1, ?) ' +
        'ON DUPLICATE KEY UPDATE snapshot_at = VALUES(snapshot_at)',
      [snapshotAt]
    );
  } catch (error) {
    console.error('Error persisting nightly job watermark:', error);
    throw error;
  }
}

/**
 * Deletes completed nightly_job_log rows older than the given number of days
 *
 * @param olderThanDays Age threshold in days for completed rows.
 * @returns The number of rows deleted.
 * @throws The underlying error when the delete fails.
 */
export async function pruneOldJobLogs(olderThanDays: number): Promise<number> {
  try {
    const [result]: any = await executeQuery(
      'DELETE FROM nightly_job_log WHERE completed_at IS NOT NULL AND completed_at < NOW() - INTERVAL ? DAY',
      [olderThanDays]
    );
    return result.affectedRows;
  } catch (error) {
    console.error('Error pruning old nightly_job_log rows:', error);
    throw error;
  }
}

/**
 * Maps a raw snake_case nightly_job_log DB row into a camelCase NightlyJobLog
 */
function mapJobLogRow(row: any): NightlyJobLog {
  return {
    id: row.id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status,
    lastCompletedPhase: row.last_completed_phase,
    processedConversationIds: parseIdArrayColumn(row.processed_conversation_ids),
    skippedConversationIds: parseIdArrayColumn(row.skipped_conversation_ids),
    errorMessage: row.error_message,
    conversationsProcessed: row.conversations_processed,
    filesUpdated: row.files_updated,
    filesCreated: row.files_created
  };
}

/** Normalizes a JSON id-array column to a string array, tolerating null/string/already-parsed shapes */
function parseIdArrayColumn(value: any): string[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error('Error parsing nightly_job_log id array column:', error);
      return [];
    }
  }
  return [];
}

/**
 * Returns the single most recent 'running' job row (an orphan from a crashed process), or null if none exists
 *
 * @returns The orphaned running job, or null.
 * @throws The underlying error when the query fails.
 */
export async function findRunningJob(): Promise<NightlyJobLog | null> {
  try {
    const [rows]: any = await executeQuery(
      "SELECT * FROM nightly_job_log WHERE status = 'running' ORDER BY id DESC LIMIT 1"
    );
    if (rows && rows.length > 0) {
      return mapJobLogRow(rows[0]);
    }
    return null;
  } catch (error) {
    console.error('Error finding running nightly_job_log row:', error);
    throw error;
  }
}

/**
 * Attempts to acquire the named processing lock, stealing it if the existing lock is stale
 *
 * @param lockName The named lock ('nightly').
 * @param owner Hostname:pid string identifying the acquiring process.
 * @param staleMs Age after which an existing lock may be stolen.
 * @returns true when the lock was acquired (fresh or stolen), false when it is held by someone else.
 * @throws The underlying error when any query fails outside the expected duplicate-entry path.
 */
export async function acquireLock(lockName: string, owner: string, staleMs: number): Promise<boolean> {
  try {
    await executeQuery('INSERT INTO processing_lock (lock_name, acquired_at, owner) VALUES (?, NOW(), ?)', [
      lockName,
      owner
    ]);
    return true;
  } catch (error: any) {
    if (error.code !== 'ER_DUP_ENTRY') {
      throw error;
    }

    const [rows]: any = await executeQuery(
      'SELECT acquired_at FROM processing_lock WHERE lock_name = ? LIMIT 1',
      [lockName]
    );
    const acquiredAt: Date = rows[0].acquired_at;
    const elapsedMs = Date.now() - acquiredAt.getTime();

    if (elapsedMs > staleMs) {
      // Compare-and-swap on the previously-read acquired_at so two callers racing to steal the same
      // stale lock cannot both succeed -- whichever UPDATE runs first changes acquired_at, so the
      // second one's WHERE no longer matches and affectedRows is 0.
      const [result]: any = await executeQuery(
        'UPDATE processing_lock SET acquired_at = NOW(), owner = ? WHERE lock_name = ? AND acquired_at = ?',
        [owner, lockName, acquiredAt]
      );
      return result.affectedRows === 1;
    }

    return false;
  }
}

/**
 * Releases the named processing lock
 *
 * @param lockName The named lock ('nightly').
 * @param owner The owner that acquired the lock (only the current owner may release it).
 * @throws The underlying error when the delete fails.
 */
export async function releaseLock(lockName: string, owner: string): Promise<void> {
  try {
    // Owner-scoped so a slow process that had its (stale) lock stolen by another run can't delete the
    // new owner's lock in its finally{} -- only the current owner may release it.
    await executeQuery('DELETE FROM processing_lock WHERE lock_name = ? AND owner = ?', [lockName, owner]);
  } catch (error) {
    console.error(`Error releasing lock "${lockName}":`, error);
    throw error;
  }
}
