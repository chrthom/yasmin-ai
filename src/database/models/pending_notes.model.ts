import { executeQuery } from '../connection';

export interface PendingNote {
  id: number;
  fromUsername: string;
  toUsername: string | null;
  content: string;
  createdAt: Date;
}

interface PendingNoteRow {
  id: number;
  from_username: string;
  to_username: string | null;
  content: string;
  created_at: Date;
}

export interface PendingNoteForDelivery {
  id: number;
  fromUsername: string;
  content: string;
}

/**
 * Maps a raw snake_case DB row into a camelCase PendingNote
 */
function mapRow(row: PendingNoteRow): PendingNote {
  return {
    id: row.id,
    fromUsername: row.from_username,
    toUsername: row.to_username,
    content: row.content,
    createdAt: row.created_at
  };
}

/**
 * Inserts a new pending note (the live agent's share_note tool)
 */
export async function insertPendingNote(
  fromUsername: string,
  toUsername: string | null,
  content: string
): Promise<number> {
  const [result]: any = await executeQuery(
    'INSERT INTO pending_notes (from_username, to_username, content, created_at) VALUES (?, ?, ?, ?)',
    [fromUsername, toUsername, content, new Date()]
  );
  return result.insertId;
}

/**
 * Fetches the notes a user may receive right now: notes addressed to them, not yet delivered
 * to them, and never their own. "Everyone"-notes (to_username NULL) are included while the
 * user is not yet listed in delivered_to; a copy addressed to them is included while
 * delivered_at is still NULL.
 */
export async function getUndeliveredNotesForUser(username: string): Promise<PendingNoteForDelivery[]> {
  const [rows]: any = await executeQuery(
    `SELECT id, from_username, content FROM pending_notes
     WHERE from_username != ?
       AND (
         (to_username = ? AND delivered_at IS NULL)
         OR (to_username IS NULL AND NOT JSON_CONTAINS(COALESCE(delivered_to, JSON_ARRAY()), JSON_QUOTE(?)))
       )
     ORDER BY created_at, id`,
    [username, username, username]
  );
  return rows.map((row: any) => ({
    id: row.id,
    fromUsername: row.from_username,
    content: row.content
  }));
}

/**
 * Claims the delivery of one note for one recipient, atomically. For a note addressed
 * individually this sets delivered_at; for an "everyone"-note it appends the recipient to
 * delivered_to. The claim is conditional on the note still being undelivered (delivered_at
 * IS NULL / recipient not yet listed), so a concurrent double delivery loses the race and
 * returns false instead of double-delivering.
 */
export async function claimNoteDelivery(noteId: number, username: string): Promise<boolean> {
  const [individual]: any = await executeQuery(
    'UPDATE pending_notes SET delivered_at = ? WHERE id = ? AND to_username = ? AND delivered_at IS NULL',
    [new Date(), noteId, username]
  );
  if (individual.affectedRows > 0) {
    return true;
  }
  const [everyone]: any = await executeQuery(
    `UPDATE pending_notes
     SET delivered_to = JSON_ARRAY_APPEND(COALESCE(delivered_to, JSON_ARRAY()), '$', JSON_QUOTE(?))
     WHERE id = ? AND to_username IS NULL AND delivered_at IS NULL
       AND NOT JSON_CONTAINS(COALESCE(delivered_to, JSON_ARRAY()), JSON_QUOTE(?))`,
    [username, noteId, username]
  );
  return everyone.affectedRows > 0;
}

/**
 * Returns the highest pending_notes id currently in the table (0 when empty). The nightly
 * consolidation snapshot is bounded by this id: notes staged after it are not yet part of the
 * snapshot and must survive the phase-6.5 reset.
 */
export async function getPendingNotesMaxId(): Promise<number> {
  const [rows]: any = await executeQuery('SELECT COALESCE(MAX(id), 0) AS max_id FROM pending_notes');
  return rows[0].max_id;
}

/**
 * Lists all notes still pending for at least one recipient, up to the given snapshot max id,
 * for the nightly catch phase.
 * Notes already delivered to their target individual (delivered_at set) are excluded -- their
 * purpose was fulfilled in the live conversation and their content lives on in the journals.
 * An "everyone"-note never sets delivered_at (recipients are claimed one by one in
 * delivered_to, and partial delivery stays pending for the remaining family members), so it
 * is consolidated until the nightly reset empties it.
 */
export async function getUnconsolidatedNotes(maxId: number): Promise<PendingNote[]> {
  const [rows]: any = await executeQuery(
    'SELECT * FROM pending_notes WHERE delivered_at IS NULL AND id <= ?',
    [maxId]
  );
  return (rows as PendingNoteRow[]).map(mapRow);
}

/**
 * Rolls back a delivery claim after the conversation request it was claimed for failed
 * (e.g. HTTP 5xx or a network error): the note becomes deliverable again with the user's
 * next input instead of being lost. Best-effort and idempotent.
 */
export async function releaseNoteDelivery(noteId: number, username: string): Promise<void> {
  const [individual]: any = await executeQuery(
    'UPDATE pending_notes SET delivered_at = NULL WHERE id = ? AND to_username = ?',
    [noteId, username]
  );
  if (individual.affectedRows > 0) {
    return;
  }
  await executeQuery(
    `UPDATE pending_notes
     SET delivered_to = JSON_REMOVE(delivered_to, JSON_UNQUOTE(JSON_SEARCH(delivered_to, 'one', ?)))
     WHERE id = ? AND to_username IS NULL AND delivered_at IS NULL
       AND JSON_SEARCH(delivered_to, 'one', ?) IS NOT NULL`,
    [username, noteId, username]
  );
}

/**
 * Empties the outbox after a successful nightly consolidation, up to the snapshot's max note
 * id. Deliberately a plain DELETE (no TRUNCATE -- it needs DROP privileges and its implicit
 * commit breaks transaction logic). The id bound closes the race with the unconditional
 * delete: a note inserted after the consolidation snapshot was taken (e.g. while the review
 * loop was still running) is NOT deleted -- it is still undelivered and unconsolidated, so
 * it stays for the next nightly run.
 */
export async function clearPendingNotes(maxId: number): Promise<void> {
  await executeQuery('DELETE FROM pending_notes WHERE id <= ?', [maxId]);
}
