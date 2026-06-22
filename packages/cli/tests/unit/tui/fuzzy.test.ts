// packages/cli/tests/unit/tui/fuzzy.test.ts
import { describe, expect, it } from "vitest";

import { fuzzyMatch } from "../../../src/tui/lib/fuzzy.js";

describe("fuzzyMatch", () => {
  it("matches a subsequence case-insensitively", () => {
    const r = fuzzyMatch("nse", "New Session");
    expect(r).not.toBeNull();
    expect(r?.positions).toEqual([0, 4, 5]); // N(0) s(4) e(5)
  });

  it("returns null when not a subsequence", () => {
    expect(fuzzyMatch("zzz", "New Session")).toBeNull();
  });

  it("returns score 0 and empty positions for an empty query", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("scores a contiguous run higher than a scattered one", () => {
    const contiguous = fuzzyMatch("ses", "Session");
    const scattered = fuzzyMatch("ses", "Some Extra Stuff");
    expect(contiguous).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect((contiguous as { score: number }).score).toBeGreaterThan(
      (scattered as { score: number }).score,
    );
  });
});
