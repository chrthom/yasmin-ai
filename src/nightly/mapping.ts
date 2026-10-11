import { config } from '../config';
import { capitalizeWord, profileTitle, sanitizeForPath } from '../strings';

/**
 * Table-driven mapping between long-term verbose file paths (memory_archive.file_path)
 * and MariaDB context_entries titles. Paths/titles with no matching rule map to null --
 * those files have no eager-cache representation in context_entries. The slug and casing
 * rules it relies on live in src/strings.ts, shared with the pipeline.
 */

interface FixedMapping {
  path: string;
  title: string;
}

const FIXED_MAPPINGS: FixedMapping[] = [
  { path: 'self-reflection/profile.md', title: config.context.profileOfYasminTitle },
  { path: 'general/family.md', title: config.context.familyNotesTitle }
];

const PEOPLE_PATH_PATTERN = /^people\/([a-z0-9_-]+)\.([A-Za-z]+)$/;
const PEOPLE_TITLE_PATTERN = /^Profile of (.+)$/;

/** Converts a people/<stem>.md stem into a "Name" title, e.g. "mary-jane" -> "Mary Jane" */
function stemToName(stem: string): string {
  return stem.split(/[-_]/).map(capitalizeWord).join(' ');
}

/**
 * Maps a long-term verbose file path to its context_entries title, or null if unmapped
 */
export function pathToTitle(path: string): string | null {
  const fixed = FIXED_MAPPINGS.find(mapping => mapping.path === path);
  if (fixed) {
    return fixed.title;
  }

  const peopleMatch = PEOPLE_PATH_PATTERN.exec(path);
  if (peopleMatch && peopleMatch[2].toLowerCase() === 'md') {
    const name = stemToName(peopleMatch[1]);
    // "yasmin" is reserved for the fixed self-reflection mapping above -- a people/ file that
    // happens to be named yasmin.md must not resolve to the same "Profile of Yasmin" title, or it
    // would silently overwrite Yasmin's own self-reflection context entry (see bootstrap-memory.ts,
    // which excludes this exact name for the same reason).
    if (name.toLowerCase() === 'yasmin') {
      return null;
    }
    return profileTitle(name);
  }

  return null;
}

/**
 * Maps a context_entries title to its long-term verbose file path, or null if unmapped
 */
export function titleToPath(title: string): string | null {
  const fixed = FIXED_MAPPINGS.find(mapping => mapping.title === title);
  if (fixed) {
    return fixed.path;
  }

  const peopleMatch = PEOPLE_TITLE_PATTERN.exec(title);
  if (peopleMatch) {
    // The shared sanitizeForPath slug rule also folds apostrophes/punctuation to hyphens, so
    // "O'Brien" maps to people/o-brien.md -- exactly the stem pathToTitle built the title from.
    return `people/${sanitizeForPath(peopleMatch[1])}.md`;
  }

  return null;
}
