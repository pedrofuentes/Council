/**
 * Tests for the Ink expert color palette.
 *
 * Each expert is assigned a stable color based on its index in the panel,
 * so the same expert renders in the same color across rounds (visual
 * continuity in the TUI).
 *
 * RED at this commit: src/cli/renderers/ink/colors.ts does not exist.
 */
import { describe, expect, it } from "vitest";

import {
  EXPERT_COLOR_PALETTE,
  assignExpertColor,
} from "../../../../../src/cli/renderers/ink/colors.js";

describe("assignExpertColor", () => {
  it("returns a color from the palette for index 0", () => {
    expect(EXPERT_COLOR_PALETTE).toContain(assignExpertColor(0));
  });

  it("is stable for the same index", () => {
    expect(assignExpertColor(2)).toBe(assignExpertColor(2));
  });

  it("cycles through the palette modulo its length", () => {
    expect(assignExpertColor(EXPERT_COLOR_PALETTE.length)).toBe(assignExpertColor(0));
    expect(assignExpertColor(EXPERT_COLOR_PALETTE.length + 3)).toBe(assignExpertColor(3));
  });

  it("the first six indices yield distinct colors", () => {
    const colors = new Set([0, 1, 2, 3, 4, 5].map((i) => assignExpertColor(i)));
    expect(colors.size).toBe(6);
  });

  it("palette includes the documented colors", () => {
    for (const c of ["cyan", "yellow", "magenta", "green", "blue", "red"]) {
      expect(EXPERT_COLOR_PALETTE).toContain(c);
    }
  });
});
