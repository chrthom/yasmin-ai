import { getCurrentVersion, listCurrentVersions } from '../database/models/memory_archive.model';

export interface StagedUpdate {
  path: string;
  content: string;
  isNew: boolean;
}

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
 * Tool: lists every long-term memory file currently known, by path and content hash
 */
export async function list_long_term_files(): Promise<{ path: string; contentHash: string }[]> {
  const rows = await listCurrentVersions();
  return rows.map(row => ({ path: row.filePath, contentHash: row.contentHash }));
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

/**
 * Tool: stages a memory file update or creation for later review; the only way to mutate staged updates
 */
export function stage_update(path: string, content: string, isNew: boolean): { success: true; path: string } {
  stagedUpdates.push({ path, content, isNew });
  return { success: true, path };
}
