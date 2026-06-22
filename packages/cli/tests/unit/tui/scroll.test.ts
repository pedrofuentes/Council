// packages/cli/tests/unit/tui/scroll.test.ts
import { describe, expect, it } from "vitest";

import { computeScrollWindow } from "../../../src/tui/lib/scroll.js";

describe("computeScrollWindow", () => {
  it("shows the whole list when it fits", () => {
    expect(computeScrollWindow({ total: 3, viewport: 10, cursor: 0, offset: 0, follow: false }))
      .toEqual({ start: 0, end: 3, offset: 0 });
  });

  it("pins to the bottom when follow is true", () => {
    expect(computeScrollWindow({ total: 100, viewport: 10, cursor: 0, offset: 0, follow: true }))
      .toEqual({ start: 90, end: 100, offset: 90 });
  });

  it("scrolls down to keep the cursor visible", () => {
    // cursor at 15, viewport 10, currently showing 0..10 -> must shift so 15 is visible
    expect(computeScrollWindow({ total: 100, viewport: 10, cursor: 15, offset: 0, follow: false }))
      .toEqual({ start: 6, end: 16, offset: 6 });
  });

  it("scrolls up to keep the cursor visible", () => {
    expect(computeScrollWindow({ total: 100, viewport: 10, cursor: 3, offset: 20, follow: false }))
      .toEqual({ start: 3, end: 13, offset: 3 });
  });

  it("clamps offset within bounds", () => {
    expect(computeScrollWindow({ total: 5, viewport: 10, cursor: 0, offset: 99, follow: false }))
      .toEqual({ start: 0, end: 5, offset: 0 });
  });
});
