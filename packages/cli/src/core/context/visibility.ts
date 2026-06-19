/**
 * Visibility scoping for prior turns (ROADMAP §2.6).
 *
 * Long debates accumulate large amounts of prior content. Without a
 * scoping policy the entire history is fed back into every prompt,
 * which (a) blows past model context windows and (b) makes per-turn
 * cost grow O(n²). `filterPriorTurns()` lets callers select a subset
 * of the history under three policies:
 *
 *   - "all"         — no filtering (status-quo default).
 *   - "same-round"  — only turns whose `round` equals the current
 *                     round. Useful for "single-round" panels where
 *                     each expert reacts only to siblings.
 *   - "recent"      — the most recent `maxPriorTurns` (default 10)
 *                     across all rounds. Caps memory linearly.
 *
 * The helper is pure: input arrays are never mutated.
 */
import type { PriorTurnRecord } from "../moderator/strategy.js";

export type VisibilityScope = "all" | "same-round" | "recent";

export interface VisibilityConfig {
  readonly scope: VisibilityScope;
  /** For "recent" scope. Default 10. */
  readonly maxPriorTurns?: number;
}

const DEFAULT_RECENT_MAX = 10;

export function filterPriorTurns(
  allTurns: readonly PriorTurnRecord[],
  _currentExpertSlug: string,
  currentRound: number,
  config: VisibilityConfig,
): readonly PriorTurnRecord[] {
  switch (config.scope) {
    case "all":
      return allTurns;
    case "same-round":
      return allTurns.filter((t) => t.round === currentRound);
    case "recent": {
      const max = config.maxPriorTurns ?? DEFAULT_RECENT_MAX;
      if (max <= 0) return [];
      if (allTurns.length <= max) return allTurns;
      return allTurns.slice(allTurns.length - max);
    }
  }
}
