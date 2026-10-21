import { getCurrentVersion, listCurrentVersions } from '../database/models/memory_archive.model';

/** One staged memory-file update produced by the nightly integrate agent, awaiting review. */
export interface StagedUpdate {
  path: string;
  content: string;
  isNew: boolean;
}

/**
 * Only these long-term memory file shapes may be staged. Anything else -- absolute paths, ".."
 * traversal, nested directories, or unknown top-level dirs -- is rejected so a wayward tool call
 * can't slip files outside the expected memory store into the archive and upload.
 */
const VALID_STAGE_PATH_RE =
  /^(people\/[a-z0-9_-]+\.md|self-reflection\/profile\.md|self-reflection\/mood\.md|general\/family\.md|general\/topic-index\.md)$/i;
const TOPICS_PATH_PREFIX = 'topics/';

/**
 * Generic path-slug sanitizer (same rule as the shared sanitizeForPath in src/strings.ts):
 * lowercase, every non [a-z0-9-] char -> '-'. German umlauts are transliterated
 * FIRST (the family converses in German, so 'Ausflüge' must become 'ausfluege', not
 * 'ausfl-ge'). Freely generated names are normalized here instead of trusted -- this also
 * neutralizes traversal ('../' becomes '--').
 */
function sanitizeSlug(slug: string): string {
  return slug
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/Ä/g, 'ae')
    .replace(/Ö/g, 'oe')
    .replace(/Ü/g, 'ue')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Normalizes a topics/ path to the canonical 'topics/<slug>.md' form. The agent freely invents topic
 * names, so casing, spaces, and a missing or oddly-cased '.md' suffix must all be tolerated, while
 * traversal fragments collapse into ordinary hyphens. Non-topics/ paths are returned unchanged.
 *
 * @param path The staged file path.
 * @returns The normalized path, or null when a topics/ path has no usable slug.
 */
export function normalizeTopicPath(path: string): string | null {
  if (!path.toLowerCase().startsWith(TOPICS_PATH_PREFIX)) {
    return path;
  }
  const stem = path.slice(TOPICS_PATH_PREFIX.length).replace(/\.md$/i, '');
  const slug = sanitizeSlug(stem);
  if (slug.length === 0 || slug === '-') {
    return null;
  }
  return TOPICS_PATH_PREFIX + slug + '.md';
}

/** One per-conversation journal entry of the current nightly run -- the evidence base for updates. */
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
 *
 * @param journals The journals phase 2 just wrote.
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
 * Tool: retrieves the full current content of a long-term memory file by exact path. Topics/ paths
 * are normalized the same way stage_update normalizes them, so an agent reading
 * 'topics/Urlaub Planung.md' finds 'topics/urlaub-planung.md' instead of a false found:false --
 * a miss here would invite the agent to create a duplicate topic.
 *
 * @param path The file path to read (topics/ paths are normalized first).
 * @returns The file's current content and normalized path, or found:false when it doesn't exist.
 */
export async function get_long_term_file(
  path: string
): Promise<{ path: string; content: string; found: boolean }> {
  const normalized = normalizeTopicPath(typeof path === 'string' ? path : '');
  if (normalized === null) {
    return { path, content: '', found: false };
  }
  const row = await getCurrentVersion(normalized);
  if (row) {
    return { path: normalized, content: row.content, found: true };
  }
  return { path: normalized, content: '', found: false };
}

/**
 * Tool: returns this run's freshly generated journal entries, the evidence base for memory updates
 */
export function read_todays_journals(): JournalEntry[] {
  return [...todaysJournals];
}

/** Result of a stage_update tool call: success with the staged path, or a self-correctable error. */
export type StageUpdateResult = { success: true; path: string } | { success: false; error: string };

/**
 * Tool: stages a memory file update or creation for later review; the only way to mutate staged updates
 *
 * Validates path/scope and content before staging. Invalid calls are rejected with an error the
 * agent can read and self-correct against, rather than silently staging "undefined" garbage that
 * would later flow into the archive and the review prompt.
 *
 * @param path The memory file path to stage (people/, self-reflection/, general/, or topics/).
 * @param content The full replacement content for the file.
 * @param isNew Whether the agent claims the file doesn't exist yet (never trusted; the pipeline
 *   classifies create-vs-update from real archive state).
 * @returns success with the (normalized) staged path, or failure with a self-correctable error.
 */
export function stage_update(path: string, content: string, isNew: boolean): StageUpdateResult {
  if (typeof path !== 'string') {
    return { success: false, error: `invalid path "${String(path)}"; expected a string` };
  }

  let stagedPath = path;
  if (path.toLowerCase().startsWith(TOPICS_PATH_PREFIX)) {
    // Topic paths are freely generated by the agent: normalize the slug (analogous to people/
    // stems) so 'Urlaub Planung' and 'urlaub-planung' land on the same file.
    const normalized = normalizeTopicPath(path);
    if (normalized === null) {
      return {
        success: false,
        error: `invalid topic path "${path}"; expected topics/<topic>.md, e.g. topics/urlaub-planung.md`
      };
    }
    stagedPath = normalized;
  } else if (!VALID_STAGE_PATH_RE.test(path)) {
    return {
      success: false,
      error:
        `invalid path "${String(path)}"; expected people/<name>.md, ` +
        'self-reflection/profile.md, self-reflection/mood.md, general/family.md, ' +
        'general/topic-index.md, or topics/<topic>.md'
    };
  } else {
    // The path regex is case-insensitive, so a non-canonical casing like 'General/Topic-Index.md'
    // passes validation; normalize to lowercase so the pipeline's exact '===' comparisons (review
    // ordering, topic-index registry validation, people/ eager mapping) cannot miss it.
    stagedPath = path.toLowerCase();
  }
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { success: false, error: `empty or non-string content for "${stagedPath}"` };
  }
  stagedUpdates.push({ path: stagedPath, content, isNew });
  return { success: true, path: stagedPath };
}
