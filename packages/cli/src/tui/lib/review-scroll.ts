// packages/cli/src/tui/lib/review-scroll.ts

export interface ReviewScrollState {
  readonly followLive: boolean;
  readonly cursor: number;
}

export type ReviewScrollAction = "up" | "down" | "end";

/**
 * Pure state machine for the debate-transcript review/live scroll toggle.
 *
 * - "up"   → enter review mode (followLive=false) and move cursor toward the top;
 *            clamps at 0. When transitioning from live, the cursor starts at the
 *            last line and steps up by one.
 * - "down" → move cursor toward the bottom; reaching the last line resumes live.
 * - "end"  → unconditionally resume live, cursor at last line.
 *
 * Returns `state` unchanged when `total === 0`.
 */
export function reviewScroll(
  state: ReviewScrollState,
  action: ReviewScrollAction,
  total: number,
): ReviewScrollState {
  if (total === 0) return state;
  const lastIndex = total - 1;

  switch (action) {
    case "up": {
      const currentCursor = state.followLive ? lastIndex : state.cursor;
      return { followLive: false, cursor: Math.max(0, currentCursor - 1) };
    }
    case "down": {
      if (state.followLive) return state;
      const newCursor = state.cursor + 1;
      if (newCursor >= lastIndex) {
        return { followLive: true, cursor: lastIndex };
      }
      return { followLive: false, cursor: newCursor };
    }
    case "end": {
      return { followLive: true, cursor: lastIndex };
    }
  }
}
