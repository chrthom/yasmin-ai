import { config } from '../config';
import { capitalizeLowerRest, personNameFromTitle, profileTitle, sanitizeForPath } from '../strings';

/**
 * Table-driven mapping between long-term verbose file paths (memory_archive.file_path)
 * and MariaDB context_entries titles. Paths/titles with no matching rule map to null --
 * those files have no eager-cache representation in context_entries.
 */

/** A fixed (non-person) mapping between a verbose file path and a context_entries title. */
interface FixedMapping {
  path: string;
  title: string;
}

const FIXED_MAPPINGS: FixedMapping[] = [
  { path: 'self-reflection/profile.md', title: config.context.profileOfYasminTitle },
  { path: 'general/family.md', title: config.context.familyNotesTitle }
];

const PEOPLE_PATH_PATTERN = /^people\/([a-z0-9_-]+)\.([A-Za-z]+)$/;

/**
 * Converts a people/<stem>.md stem into a "Name" title, e.g. "mary-jane" -> "Mary Jane"
 *
 * @param stem The slug part of a people/ file path.
 * @returns The display name built from the stem parts.
 */
function stemToName(stem: string): string {
  return stem.split(/[-_]/).map(capitalizeLowerRest).join(' ');
}

/**
 * Maps a long-term verbose file path to its context_entries title, or null if unmapped
 *
 * @param path The memory_archive file path.
 * @returns The eager-cache title for the path, or null when the file has no eager mapping.
 */
export function pathToTitle(path: string): string | null {
  const fixed = FIXED_MAPPINGS.find(mapping => mapping.path === path);
  if (fixed) {
    return fixed.title;
  }

  const peopleMatch = PEOPLE_PATH_PATTERN.exec(path);
  if (peopleMatch && peopleMatch[2].toLowerCase() === 'md') {
    const name = stemToName(peopleMatch[1]);
    // "yasmin" is reserved for the fixed self-reflection mapping above -- a people/ file named
    // yasmin.md must not resolve to the same "Profile of Yasmin" title and silently overwrite
    // Yasmin's own self-reflection entry (bootstrap-memory.ts excludes the name for the same reason).
    if (name.toLowerCase() === 'yasmin') {
      return null;
    }
    return profileTitle(name);
  }

  return null;
}

/**
 * Maps a context_entries title to its long-term verbose file path, or null if unmapped
 *
 * @param title The context_entries title.
 * @returns The memory_archive file path for the title, or null when the title has no eager mapping.
 */
export function titleToPath(title: string): string | null {
  const fixed = FIXED_MAPPINGS.find(mapping => mapping.title === title);
  if (fixed) {
    return fixed.path;
  }

  const personName = personNameFromTitle(title);
  if (personName !== null) {
    // The same stem function the pipeline uses for journal paths -- the title<->path round-trip
    // (see __tests__/mapping.test.ts) depends on both directions going through it.
    return `people/${sanitizeForPath(personName)}.md`;
  }

  return null;
}
