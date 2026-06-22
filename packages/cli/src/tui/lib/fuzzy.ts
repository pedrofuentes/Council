// packages/cli/src/tui/lib/fuzzy.ts

export interface FuzzyResult {
  readonly score: number;
  readonly positions: readonly number[];
}

/**
 * Case-insensitive subsequence match. Returns matched character indices and a
 * score that rewards contiguous, early matches; null when `query` is not a
 * subsequence of `text`. An empty query matches everything (score 0).
 */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  if (query.length === 0) return { score: 0, positions: [] };

  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions: number[] = [];

  let ti = 0;
  let score = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi];
    let found = -1;
    for (; ti < t.length; ti += 1) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
    }
    if (found === -1) return null;
    positions.push(found);
    // Reward contiguity (adjacent to previous match) and earliness.
    score += found === prev + 1 ? 3 : 1;
    score += found < 4 ? 1 : 0;
    prev = found;
    ti = found + 1;
  }
  return { score, positions };
}
