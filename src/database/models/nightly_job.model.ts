import { executeQuery } from '../connection';

export type NightlyJobStatus = 'running' | 'completed' | 'partial' | 'failed';

export interface NightlyJobLog {
  id: number;
  startedAt: Date;
  completedAt: Date | null;
  status: NightlyJobStatus;
  lastCompletedPhase: string | null;
  processedConversationIds: string[];
  skippedConversationIds: string[];
  retryCount: number;
  errorMessage: string | null;
  conversationsProcessed: number;
  filesUpdated: number;
  filesCreated: number;
}

export interface NightlyJobLogPatch {
  status?: NightlyJobStatus;
  lastCompletedPhase?: string;
  processedConversationIds?: string[];
  skippedConversationIds?: string[];
  retryCount?: number;
  errorMessage?: string;
  conversationsProcessed?: number;
  filesUpdated?: number;
  filesCreated?: number;
  completedAt?: boolean;
}

/**
 * Creates a new nightly_job_log row with status 'running'
 * @returns The insertId of the new row
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

    if (patch.retryCount !== undefined) {
      fields.push('retry_count = ?');
      values.push(patch.retryCount);
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
 * Returns the completed_at timestamp of the most recently completed job, or null if none
 */
export async function getWatermark(): Promise<Date | null> {
  try {
    const [rows]: any = await executeQuery(
      "SELECT MAX(completed_at) AS watermark FROM nightly_job_log WHERE status = 'completed'"
    );
    return rows[0]?.watermark ?? null;
  } catch (error) {
    console.error('Error retrieving nightly job watermark:', error);
    throw error;
  }
}

/**
 * Deletes completed nightly_job_log rows older than the given number of days
 * @returns The number of rows deleted
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
 * Attempts to acquire the named processing lock, stealing it if the existing lock is stale
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
      await executeQuery('UPDATE processing_lock SET acquired_at = NOW(), owner = ? WHERE lock_name = ?', [
        owner,
        lockName
      ]);
      return true;
    }

    return false;
  }
}

/**
 * Releases the named processing lock
 */
export async function releaseLock(lockName: string): Promise<void> {
  try {
    await executeQuery('DELETE FROM processing_lock WHERE lock_name = ?', [lockName]);
  } catch (error) {
    console.error(`Error releasing lock "${lockName}":`, error);
    throw error;
  }
}
