/**
 * Tests for the unified expert color palette (T-04).
 *
 * Validates:
 * - Palette has 8 colors
 * - Red is NOT in the palette (TUI-13)
 * - yellowBright replaces red
 * - Palette includes cyanBright and magentaBright
 * - assignExpertColor still cycles correctly
 * - formatExpertPrefix produces "[N] Name" format (A11Y-01)
 */
import { describe, expect, it } from "vitest";

import {
  EXPERT_COLOR_PALETTE,
  assignExpertColor,
  formatExpertPrefix,
} from "../../../../../src/cli/renderers/ink/colors.js";

describe("Unified EXPERT_COLOR_PALETTE", () => {
  it("contains exactly 8 colors", () => {
    expect(EXPERT_COLOR_PALETTE).toHaveLength(8);
  });

  it("does NOT include red (TUI-13 — red reserved for errors)", () => {
    expect(EXPERT_COLOR_PALETTE).not.toContain("red");
  });

  it("includes yellowBright as a replacement for red", () => {
    expect(EXPERT_COLOR_PALETTE).toContain("yellowBright");
  });

  it("includes cyanBright and magentaBright", () => {
    expect(EXPERT_COLOR_PALETTE).toContain("cyanBright");
    expect(EXPERT_COLOR_PALETTE).toContain("magentaBright");
  });

  it("includes the core 5 non-red colors", () => {
    for (const c of ["cyan", "yellow", "magenta", "green", "blue"]) {
      expect(EXPERT_COLOR_PALETTE).toContain(c);
    }
  });

  it("all 8 entries are distinct", () => {
    const unique = new Set(EXPERT_COLOR_PALETTE);
    expect(unique.size).toBe(8);
  });
});

describe("assignExpertColor with 8-color palette", () => {
  it("cycles at palette length 8", () => {
    expect(assignExpertColor(8)).toBe(assignExpertColor(0));
    expect(assignExpertColor(11)).toBe(assignExpertColor(3));
  });

  it("first 8 indices yield distinct colors", () => {
    const colors = new Set(Array.from({ length: 8 }, (_, i) => assignExpertColor(i)));
    expect(colors.size).toBe(8);
  });
});

describe("formatExpertPrefix (A11Y-01)", () => {
  it("returns '[N] Name' format with 1-based index", () => {
    expect(formatExpertPrefix(0, "Alice")).toBe("[1] Alice");
    expect(formatExpertPrefix(1, "Bob")).toBe("[2] Bob");
    expect(formatExpertPrefix(9, "Tenth")).toBe("[10] Tenth");
  });
});
