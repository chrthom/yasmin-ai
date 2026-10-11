/**
 * Shared string utility functions.
 *
 * This module centralizes commonly used string transformations to avoid duplication
 * and ensure consistent behavior across the codebase.
 */

/**
 * Sanitizes a string for use in file paths.
 * Lowercases the input and replaces every character that is not a-z, 0-9, or hyphen with a hyphen.
 *
 * This is used for:
 * - Converting conversation names to journal file paths in the nightly pipeline
 * - Converting profile names to people/ file stems for path-title mapping
 *
 * Examples:
 * - "Mary Jane" -> "mary-jane"
 * - "O'Brien" -> "o-brien"
 * - "Christopher" -> "christopher"
 */
export function sanitizeForPath(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * Capitalizes only the first character of a string, leaving the rest unchanged.
 *
 * Use this when you want to preserve the case of the remaining characters.
 *
 * Example: "christopher" -> "Christopher", "McDonald" -> "McDonald"
 */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Capitalizes the first character and lowercases the rest of a string.
 *
 * Use this when you want a normalized title-case version where only the first letter
 * is uppercase and all subsequent letters are lowercase.
 *
 * Example: "mary" -> "Mary", "JANE" -> "Jane", "mARY" -> "Mary"
 */
export function capitalizeNormalized(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
