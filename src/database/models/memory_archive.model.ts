import { createHash } from 'node:crypto';
import { executeQuery } from '../connection';

/** One memory_archive row: a versioned, verbose long-term memory file (the pipeline's source of truth). */
export interface MemoryArchiveRow {
  id: number;
  filePath: string;
  content: string;
  contentHash: string;
  version: number;
  mistralDocId: string | null;
  syncedAt: Date | null;
  createdAt: Date;
}

/**
 * Maps a raw snake_case DB row into a camelCase MemoryArchiveRow
 *
 * @param row The raw mysql2 row.
 * @returns The mapped archive row.
 */
function mapRow(row: any): MemoryArchiveRow {
  return {
    id: row.id,
    filePath: row.file_path,
    content: row.content,
    contentHash: row.content_hash,
    version: row.version,
    mistralDocId: row.mistral_doc_id,
    syncedAt: row.synced_at,
    createdAt: row.created_at
  };
}

/**
 * Computes the SHA-256 hex digest of the given content
 *
 * @param content The file content to hash.
 * @returns The hex digest, used to detect unchanged rewrites.
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Retrieves the current (highest version) row for a file path, or null if none exists
 *
 * @param filePath The memory file path.
 * @returns The current archive row, or null when the path has no version yet.
 * @throws The underlying error when the query fails.
 */
export async function getCurrentVersion(filePath: string): Promise<MemoryArchiveRow | null> {
  try {
    const [rows]: any = await executeQuery(
      'SELECT * FROM memory_archive WHERE file_path = ? ORDER BY version DESC LIMIT 1',
      [filePath]
    );
    if (rows && rows.length > 0) {
      return mapRow(rows[0]);
    }
    return null;
  } catch (error) {
    console.error(`Error retrieving current memory_archive version for "${filePath}":`, error);
    throw error;
  }
}

/**
 * Inserts the next version for a file path, unless content is unchanged from the current version
 *
 * @param filePath The memory file path.
 * @param content The full new file content.
 * @param createdAt The timestamp to record (defaults to now; the pipeline passes its snapshot time).
 * @returns The resulting row and whether a new version was actually created.
 * @throws The underlying error when any query fails.
 */
export async function insertNextVersion(
  filePath: string,
  content: string,
  createdAt?: Date
): Promise<{ row: MemoryArchiveRow; created: boolean }> {
  try {
    const contentHash = computeContentHash(content);
    const current = await getCurrentVersion(filePath);

    if (current && current.contentHash === contentHash) {
      return { row: current, created: false };
    }

    const nextVersion = current ? current.version + 1 : 1;
    // Write created_at explicitly (in the same UTC serialization the pool uses for every JS Date,
    // matching nightly_job_log.completed_at) rather than relying on the DB server's CURRENT_TIMESTAMP
    // default, whose local timezone may differ from the nightly pipeline's own timestamps.
    const created = createdAt ?? new Date();
    const [result]: any = await executeQuery(
      'INSERT INTO memory_archive (file_path, content, content_hash, version, mistral_doc_id, synced_at, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)',
      [filePath, content, contentHash, nextVersion, created]
    );

    const [rows]: any = await executeQuery('SELECT * FROM memory_archive WHERE id = ? LIMIT 1', [
      result.insertId
    ]);
    return { row: mapRow(rows[0]), created: true };
  } catch (error) {
    console.error(`Error inserting next memory_archive version for "${filePath}":`, error);
    throw error;
  }
}

/**
 * Lists the current (MAX version) row for every file_path
 *
 * @returns The current version of every archived file path.
 * @throws The underlying error when the query fails.
 */
export async function listCurrentVersions(): Promise<MemoryArchiveRow[]> {
  try {
    const [rows]: any = await executeQuery(
      `SELECT ma.* FROM memory_archive ma
       INNER JOIN (
         SELECT file_path, MAX(version) AS max_version FROM memory_archive GROUP BY file_path
       ) latest ON latest.file_path = ma.file_path AND latest.max_version = ma.version`
    );
    return rows.map(mapRow);
  } catch (error) {
    console.error('Error listing current memory_archive versions:', error);
    throw error;
  }
}

/**
 * Marks a memory_archive row as synced to Mistral
 *
 * @param id The archive row id.
 * @param mistralDocId The id of the uploaded library document.
 * @throws The underlying error when the update fails.
 */
export async function markSynced(id: number, mistralDocId: string): Promise<void> {
  try {
    await executeQuery('UPDATE memory_archive SET mistral_doc_id = ?, synced_at = NOW() WHERE id = ?', [
      mistralDocId,
      id
    ]);
  } catch (error) {
    console.error(`Error marking memory_archive id ${id} as synced:`, error);
    throw error;
  }
}

/**
 * Lists current versions that have not yet been synced to Mistral
 *
 * @returns The unsynced current versions, ready for library upload.
 * @throws The underlying error when the query fails.
 */
export async function listUnsynced(): Promise<MemoryArchiveRow[]> {
  try {
    const [rows]: any = await executeQuery(
      `SELECT ma.* FROM memory_archive ma
       INNER JOIN (
         SELECT file_path, MAX(version) AS max_version FROM memory_archive GROUP BY file_path
       ) latest ON latest.file_path = ma.file_path AND latest.max_version = ma.version
       WHERE ma.synced_at IS NULL`
    );
    return rows.map(mapRow);
  } catch (error) {
    console.error('Error listing unsynced memory_archive versions:', error);
    throw error;
  }
}

/**
 * Prunes old versions per file_path, keeping the most recent keepN but never fewer than keepMin
 *
 * @param keepN How many versions to keep per path.
 * @param keepMin Lower bound for the kept-version count.
 * @returns The total number of rows deleted.
 * @throws The underlying error when any query fails.
 */
export async function pruneOldVersions(keepN: number, keepMin: number): Promise<number> {
  try {
    const [pathRows]: any = await executeQuery(
      'SELECT file_path, COUNT(*) AS version_count FROM memory_archive GROUP BY file_path'
    );

    let totalDeleted = 0;
    const keep = Math.max(keepN, keepMin);

    for (const pathRow of pathRows) {
      const filePath = pathRow.file_path;
      const versionCount = pathRow.version_count;

      if (versionCount <= keep) {
        continue;
      }

      const [versionRows]: any = await executeQuery(
        'SELECT version FROM memory_archive WHERE file_path = ? ORDER BY version DESC',
        [filePath]
      );
      const versionsToDelete = versionRows.slice(keep).map((row: any) => row.version);

      if (versionsToDelete.length === 0) {
        continue;
      }

      const placeholders = versionsToDelete.map(() => '?').join(', ');
      const [result]: any = await executeQuery(
        `DELETE FROM memory_archive WHERE file_path = ? AND version IN (${placeholders})`,
        [filePath, ...versionsToDelete]
      );
      totalDeleted += result.affectedRows;
    }

    return totalDeleted;
  } catch (error) {
    console.error('Error pruning old memory_archive versions:', error);
    throw error;
  }
}
