import { executeQuery } from '../connection';

/**
 * Canonical casing for usernames at the outbox boundary. Column comparisons (to_username = ?)
 * follow the utf8mb4 *_ci collation and are case-insensitive, but the JSON_CONTAINS /
 * JSON_SEARCH matching on delivered_to compares strings codepoint-sensitively -- without
 * normalizing, a user appearing once as "Zara" and once as "zara" could receive an
 * "everyone"-note twice. All delivered_to writes, comparisons and lookups use this form.
 */
function canonicalUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** Escapes the LIKE wildcards % and _ (JSON_SEARCH patterns) by doubling the escape char */
function escapeLike(pattern: string): string {
  return pattern.replace(/[%_\\]/g, m => '\\' + m);
}

/** One row of the cross-person note outbox, as stored in intraday_notes. */
export interface IntradayNote {
  id: number;
  fromUsername: string;
  toUsername: string | null;
  content: string;
  createdAt: Date;
}

/** Raw snake_case intraday_notes DB row, mapped by mapRow. */
interface IntradayNoteRow {
  id: number;
  from_username: string;
  to_username: string | null;
  content: string;
  created_at: Date;
}

/** A pending note that is deliverable to a recipient right now (id, sender, content). */
export interface IntradayNoteForDelivery {
  id: number;
  fromUsername: string;
  content: string;
}

/**
 * Maps a raw snake_case DB row into a camelCase IntradayNote
 */
function mapRow(row: IntradayNoteRow): IntradayNote {
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
 *
 * @param fromUsername The note's sender.
 * @param toUsername The single recipient's name, or null for "everyone".
 * @param content The note text.
 * @returns The inserted row's id.
 * @throws The underlying error when the insert fails.
 */
export async function insertIntradayNote(
  fromUsername: string,
  toUsername: string | null,
  content: string
): Promise<number> {
  const [result]: any = await executeQuery(
    'INSERT INTO intraday_notes (from_username, to_username, content, created_at) VALUES (?, ?, ?, ?)',
    [fromUsername, toUsername, content, new Date()]
  );
  return result.insertId;
}

/**
 * Fetches the notes a user may receive right now: notes addressed to them, not yet delivered
 * to them, and never their own. "Everyone"-notes (to_username NULL) are included while the
 * user is not yet listed in delivered_to; a copy addressed to them is included while
 * delivered_at is still NULL.
 *
 * @param username The recipient's username.
 * @returns The deliverable notes, oldest first.
 * @throws The underlying error when the query fails.
 */
export async function getUndeliveredNotesForUser(username: string): Promise<IntradayNoteForDelivery[]> {
  const canonical = canonicalUsername(username);
  const [rows]: any = await executeQuery(
    `SELECT id, from_username, content FROM intraday_notes
     WHERE from_username != ?
       AND (
         (to_username = ? AND delivered_at IS NULL)
         OR (to_username IS NULL AND NOT JSON_CONTAINS(COALESCE(delivered_to, JSON_ARRAY()), JSON_QUOTE(?)))
       )
     ORDER BY created_at, id`,
    [username, username, canonical]
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
 *
 * @param noteId The note being delivered.
 * @param username The recipient claiming the delivery.
 * @returns true when this call won the claim, false when another delivery already claimed it.
 * @throws The underlying error when either update fails.
 */
export async function claimNoteDelivery(noteId: number, username: string): Promise<boolean> {
  const canonical = canonicalUsername(username);
  const [individual]: any = await executeQuery(
    'UPDATE intraday_notes SET delivered_at = ? WHERE id = ? AND to_username = ? AND delivered_at IS NULL',
    [new Date(), noteId, username]
  );
  if (individual.affectedRows > 0) {
    return true;
  }
  const [everyone]: any = await executeQuery(
    `UPDATE intraday_notes
     SET delivered_to = JSON_ARRAY_APPEND(COALESCE(delivered_to, JSON_ARRAY()), '$', JSON_QUOTE(?))
     WHERE id = ? AND to_username IS NULL AND delivered_at IS NULL
       AND NOT JSON_CONTAINS(COALESCE(delivered_to, JSON_ARRAY()), JSON_QUOTE(?))`,
    [canonical, noteId, canonical]
  );
  return everyone.affectedRows > 0;
}

/**
 * Returns the highest intraday_notes id currently in the table (0 when empty). The nightly
 * consolidation snapshot is bounded by this id: notes staged after it are not yet part of the
 * snapshot and must survive the phase-8 reset.
 *
 * @returns The current MAX(id), or 0 when the table is empty.
 * @throws The underlying error when the query fails.
 */
export async function getIntradayNotesMaxId(): Promise<number> {
  const [rows]: any = await executeQuery('SELECT COALESCE(MAX(id), 0) AS max_id FROM intraday_notes');
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
 *
 * @param maxId The snapshot bound -- only notes with id <= maxId are returned.
 * @returns The still-pending notes up to the snapshot bound.
 * @throws The underlying error when the query fails.
 */
export async function getUnconsolidatedNotes(maxId: number): Promise<IntradayNote[]> {
  const [rows]: any = await executeQuery(
    'SELECT * FROM intraday_notes WHERE delivered_at IS NULL AND id <= ?',
    [maxId]
  );
  return (rows as IntradayNoteRow[]).map(mapRow);
}

/**
 * Rolls back a delivery claim after the conversation request it was claimed for failed
 * (e.g. HTTP 5xx or a network error): the note becomes deliverable again with the user's
 * next input instead of being lost. Best-effort and idempotent.
 *
 * @param noteId The note whose delivery should be rolled back.
 * @param username The recipient whose claim is released.
 * @throws The underlying error when the rollback update fails.
 */
export async function releaseNoteDelivery(noteId: number, username: string): Promise<void> {
  // JSON_SEARCH treats its argument as a search pattern (with % and _ wildcards), not as a
  // literal -- escape both so a username containing them cannot over-match.
  const canonical = escapeLike(canonicalUsername(username));
  const [individual]: any = await executeQuery(
    'UPDATE intraday_notes SET delivered_at = NULL WHERE id = ? AND to_username = ?',
    [noteId, username]
  );
  if (individual.affectedRows > 0) {
    return;
  }
  await executeQuery(
    `UPDATE intraday_notes
     SET delivered_to = JSON_REMOVE(delivered_to, JSON_UNQUOTE(JSON_SEARCH(delivered_to, 'one', ?)))
     WHERE id = ? AND to_username IS NULL AND delivered_at IS NULL
       AND JSON_SEARCH(delivered_to, 'one', ?) IS NOT NULL`,
    [canonical, noteId, canonical]
  );
}

/**
 * Empties the outbox after a successful nightly consolidation, up to the snapshot's max note
 * id. Deliberately a plain DELETE (no TRUNCATE -- it needs DROP privileges and its implicit
 * commit breaks transaction logic). The id bound closes the race with the unconditional
 * delete: a note inserted after the consolidation snapshot was taken (e.g. while the review
 * loop was still running) is NOT deleted -- it is still undelivered and unconsolidated, so
 * it stays for the next nightly run.
 *
 * @param maxId Only notes with id <= maxId are deleted (the snapshot bound).
 * @throws The underlying error when the delete fails.
 */
export async function clearIntradayNotes(maxId: number): Promise<void> {
  await executeQuery('DELETE FROM intraday_notes WHERE id <= ?', [maxId]);
}
