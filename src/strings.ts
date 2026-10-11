/**
 * Single source of truth for the person-name normalizations shared between the live chat path
 * (ChatAgent, ContextService) and the nightly memory pipeline (pipeline.ts, mapping.ts).
 *
 * The people/<stem>.md <-> "Profile of <Name>" mapping only round-trips because path and title
 * construction go through the exact same functions here. The variants below differ in what they
 * do to the rest of the string, so every caller picks its variant deliberately:
 *
 * - sanitizeForPath:          lower-cases everything, slugifies for file paths
 * - capitalizePreserveRest:  upper-cases the first char, keeps the rest as typed
 * - capitalizeLowerRest:      upper-cases the first char, lower-cases the rest
 * - profileTitle:            no case handling at all, just the title template
 */

/**
 * Lower-cases the input and replaces every character that is not a-z, 0-9, or hyphen with a
 * hyphen (e.g. "Mary Jane" -> "mary-jane", "O'Brien" -> "o-brien").
 *
 * The canonical stem function for memory file paths: the nightly pipeline builds journal paths
 * with it, and the people/ title mapping reverses "Profile of <Name>" titles with it. The
 * path<->title mapping silently breaks in both directions if this function is changed, so both
 * directions share this one implementation.
 */
export function sanitizeForPath(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * Upper-cases the first character and PRESERVES the rest as typed (e.g. "mary" -> "Mary",
 * "McNeal" -> "McNeal", "o'brien" -> "O'brien"). Use for user-supplied names whose own casing
 * must be respected, e.g. note senders and recipients in the live agent.
 */
export function capitalizePreserveRest(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Upper-cases the first character and LOWER-CASES the rest (e.g. "mary" -> "Mary", "MARY" ->
 * "Mary"). Use when a canonical, deterministic rendering is required, e.g. rebuilding a display
 * name from a slug part of a memory file path, where the original casing has already been lost.
 */
export function capitalizeLowerRest(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Builds the canonical "Profile of <name>" context_entries title. Performs no case normalization
 * of its own: lookups against context_entries titles are case-insensitive, so callers pass the
 * name in exactly the casing they have and pick a capitalize variant deliberately if they need
 * a canonical rendering.
 */
export function profileTitle(name: string): string {
  return `Profile of ${name}`;
}
