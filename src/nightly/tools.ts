import { getCurrentVersion, listCurrentVersions } from '../database/models/memory_archive.model';

export interface StagedUpdate {
  path: string;
  content: string;
  isNew: boolean;
}

// Only these long-term memory file shapes may be staged. Anything else -- absolute paths, ".."
// traversal, nested directories, or unknown top-level dirs -- is rejected so a wayward tool call
// can't slip files outside the expected memory store into the archive and upload.
const VALID_STAGE_PATH_RE = /^(people\/[a-z0-9_-]+\.md|self-reflection\/profile\.md|general\/family\.md)$/i;

export interface JournalEntry {
  conversationId: string;
  userName: string;
  content: string;
}

let stagedUpdates: StagedUpdate[] = [];
let todaysJournals: JournalEntry[] = [];

/**
 * Clears all in-process nightly tool state; must be called at the start of every nightly run
 */
export function resetNightlyToolsState(): void {
  stagedUpdates = [];
  todaysJournals = [];
}

/**
 * Replaces the in-process journal entries with this run's freshly generated journals
 */
export function setTodaysJournals(journals: JournalEntry[]): void {
  todaysJournals = journals;
}

/**
 * Returns a copy of the currently staged memory file updates
 */
export function getStagedUpdates(): StagedUpdate[] {
  return [...stagedUpdates];
}

/**
 * Tool: lists every long-term memory file currently known, by path, content hash, and last_touched_at
 *
 * last_touched_at is the created_at of the file's current memory_archive version -- the last time new
 * evidence actually changed the content. It is the aging signal for the decay instruction: facts that
 * have not been corroborated for more than 180 days are deleted when the file is rewritten.
 */
export async function list_long_term_files(): Promise<
  {
    path: string;
    contentHash: string;
    lastTouchedAt: string;
  }[]
> {
  const rows = await listCurrentVersions();
  return rows.map(row => ({
    path: row.filePath,
    contentHash: row.contentHash,
    lastTouchedAt: row.createdAt.toISOString()
  }));
}

/**
 * Tool: retrieves the full current content of a long-term memory file by exact path
 */
export async function get_long_term_file(
  path: string
): Promise<{ path: string; content: string; found: boolean }> {
  const row = await getCurrentVersion(path);
  if (row) {
    return { path, content: row.content, found: true };
  }
  return { path, content: '', found: false };
}

/**
 * Tool: returns this run's freshly generated journal entries, the evidence base for memory updates
 */
export function read_todays_journals(): JournalEntry[] {
  return [...todaysJournals];
}

export type StageUpdateResult = { success: true; path: string } | { success: false; error: string };

/**
 * Tool: stages a memory file update or creation for later review; the only way to mutate staged updates
 *
 * Validates path/scope and content before staging. Invalid calls are rejected with an error the
 * agent can read and self-correct against, rather than silently staging "undefined" garbage that
 * would later flow into the archive and the review prompt.
 */
export function stage_update(path: string, content: string, isNew: boolean): StageUpdateResult {
  if (typeof path !== 'string' || !VALID_STAGE_PATH_RE.test(path)) {
    return {
      success: false,
      error:
        `invalid path "${String(path)}"; expected people/<name>.md, ` +
        'self-reflection/profile.md, or general/family.md'
    };
  }
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { success: false, error: `empty or non-string content for "${path}"` };
  }
  stagedUpdates.push({ path, content, isNew });
  return { success: true, path };
}
