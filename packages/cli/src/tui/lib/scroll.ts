// packages/cli/src/tui/lib/scroll.ts

export interface ScrollWindowInput {
  readonly total: number;
  readonly viewport: number;
  readonly cursor: number;
  readonly offset: number;
  readonly follow: boolean;
}

export interface ScrollWindow {
  readonly start: number;
  readonly end: number;
  readonly offset: number;
}

/**
 * Pure windowing math for a vertically scrolling list. Keeps the cursor visible,
 * pins to the bottom while `follow` is true, and clamps the offset to valid
 * bounds. `viewport` is the number of visible rows.
 */
export function computeScrollWindow(input: ScrollWindowInput): ScrollWindow {
  const viewport = Math.max(1, input.viewport);
  const maxOffset = Math.max(0, input.total - viewport);

  let offset: number;
  if (input.follow) {
    offset = maxOffset;
  } else if (input.cursor >= 0 && input.cursor < input.offset) {
    offset = input.cursor; // cursor above window -> scroll up
  } else if (input.cursor >= input.offset + viewport) {
    offset = input.cursor - viewport + 1; // cursor below window -> scroll down
  } else {
    offset = input.offset;
  }

  offset = Math.min(Math.max(0, offset), maxOffset);
  return { start: offset, end: Math.min(input.total, offset + viewport), offset };
}
