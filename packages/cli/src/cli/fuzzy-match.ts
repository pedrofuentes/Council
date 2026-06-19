/**
 * Fuzzy-match utility for slug typo suggestions.
 *
 * Self-contained Levenshtein implementation — no external dependencies.
 */

/**
 * Compute the Levenshtein (edit) distance between two strings.
 *
 * Uses the classic dynamic-programming approach with O(min(a,b)) space.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure `a` is the shorter string for space efficiency.
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const aLen = a.length;
  const bLen = b.length;
  let prev: number[] = Array.from({ length: aLen + 1 }, (_, i) => i);
  let curr: number[] = new Array<number>(aLen + 1).fill(0);

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j;
    for (let i = 1; i <= aLen; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        (prev[i] ?? 0) + 1,
        (curr[i - 1] ?? 0) + 1,
        (prev[i - 1] ?? 0) + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[aLen] ?? 0;
}

/**
 * Find the closest matches from a list of candidates.
 *
 * Returns candidates within `maxDistance` of the input, sorted by
 * ascending distance. Returns at most 3 suggestions.
 */
export function suggestMatch(
  input: string,
  candidates: readonly string[],
  maxDistance = 3,
): string[] {
  if (candidates.length === 0) return [];

  const scored = candidates
    .map((c) => ({ candidate: c, distance: levenshtein(input, c) }))
    .filter((s) => s.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance);

  return scored.slice(0, 3).map((s) => s.candidate);
}
