/**
 * Canonical text normalization functions for consistent string comparison.
 * Use these instead of inline `normalize("NFKC").trim().toLowerCase()` patterns.
 */

/**
 * Canonical identity normalization.
 * Use for: skill names, intent IDs, agent IDs, any identifier comparison.
 * Pattern: NFKC → trim → lowercase
 */
export function canonicalIdentity(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

/**
 * Normalize for display/comparison with whitespace collapsing.
 * Use for: user-facing text, phrase matching, description comparison.
 * Pattern: NFKC → trim → lowercase → collapse whitespace
 */
export function normalizeForComparison(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
}

/**
 * Normalize for keyword matching (whitespace-insensitive).
 * Use for: keyword lookup, trigger matching, fastpath comparison.
 * Pattern: NFKC → remove all whitespace → lowercase
 */
export function normalizeForKeyword(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
}
