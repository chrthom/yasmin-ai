/**
 * Shared string rules for names, path slugs, and context entry titles -- the single source of
 * truth used by both the live agent and the nightly pipeline. These helpers used to exist as
 * mirrored copies (the pipeline's sanitizeForPath, the mapping's nameToStem/capitalizePart,
 * inline `Profile of ${username}` constructions), and a silent drift between the copies broke
 * the nightly file <-> title mapping with no test failing. Callers must pick the casing
 * variant deliberately -- the three case behaviors differ and are documented per function.
 */

/**
 * Lower-cases the input and replaces every character that is not a-z, 0-9, or hyphen with a
 * hyphen. The one shared slug rule for memory file path segments: journal directory names in
 * the nightly pipeline and people/<stem>.md stems in the mapping both derive from it, so a
 * "Profile of Mary Jane" title always maps back to the very stem its title was built from.
 */
export function sanitizeForPath(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * Upper-cases the first character and leaves the rest UNTOUCHED ("annaLise" -> "AnnaLise").
 * Use when the remainder is already cased and must be preserved as-is, e.g. Synology usernames
 * in note delivery lines and share_note recipients.
 */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Upper-cases the first character and LOWER-CASES the rest ("jANE" -> "Jane"). Use when a
 * canonical word must be built from freely-cased input, e.g. turning a people/mary-jane.md stem
 * into the title name "Mary Jane" -- pick this variant deliberately when the input casing
 * cannot be trusted, and capitalize() when it must be preserved.
 */
export function capitalizeWord(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Builds the canonical "Profile of <name>" context entry title. The name is embedded VERBATIM
 * -- no case handling at all (the third case behavior, next to capitalize and capitalizeWord):
 * eager title matching is case-insensitive and the stored entry's own casing always wins, so
 * the raw sender username is good enough here. The mapping derives canonical-cased names from
 * stems via capitalizeWord instead.
 */
export function profileTitle(name: string): string {
  return `Profile of ${name}`;
}
