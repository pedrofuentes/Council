import { describe, expect, it } from "vitest";

import { EXPERT_COLORS, expertColorIndex, resolveExpertPalette } from "../../../src/tui/theme/expert-palette.js";

describe("expertColorIndex", () => {
  it("is deterministic — same key yields same index across calls", () => {
    const idx1 = expertColorIndex("alice");
    const idx2 = expertColorIndex("alice");
    expect(idx1).toBe(idx2);
  });

  it("result is always in [0, EXPERT_COLORS.length)", () => {
    const keys = ["alice", "bob", "carol", "dave", "eve", "frank", "grace", "hank", "", "z"];
    for (const key of keys) {
      const idx = expertColorIndex(key);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(EXPERT_COLORS.length);
    }
  });

  it("different keys generally produce different indices", () => {
    const indices = new Set(["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].map(expertColorIndex));
    expect(indices.size).toBeGreaterThan(1);
  });

  it('exact index for "alice" locks the hash algorithm', () => {
    // "alice" charCodes: 97+108+105+99+101 = 510; 510 % 6 = 0
    expect(expertColorIndex("alice")).toBe(510 % EXPERT_COLORS.length);
  });
});

describe("resolveExpertPalette — color on", () => {
  it("indexOf delegates to expertColorIndex", () => {
    const palette = resolveExpertPalette({});
    expect(palette.indexOf("alice")).toBe(expertColorIndex("alice"));
  });

  it("color(key) returns a function that wraps the string", () => {
    const palette = resolveExpertPalette({});
    const colorize = palette.color("alice");
    expect(typeof colorize).toBe("function");
    expect(colorize("hello")).toContain("hello");
  });

  it("color(key) produces different output than plain string when color enabled", () => {
    const palette = resolveExpertPalette({});
    const colorize = palette.color("alice");
    // With chalk level 1 the output includes ANSI escape codes, so it's longer than plain
    expect(colorize("x")).not.toBe("x");
  });
});

describe("resolveExpertPalette — color disabled", () => {
  it("color(key)(s) === s when NO_COLOR=1", () => {
    const palette = resolveExpertPalette({ NO_COLOR: "1" });
    const colorize = palette.color("alice");
    expect(colorize("hello")).toBe("hello");
  });

  it("color(key)(s) === s when TERM=dumb", () => {
    const palette = resolveExpertPalette({ TERM: "dumb" });
    const colorize = palette.color("bob");
    expect(colorize("world")).toBe("world");
  });

  it("indexOf still returns correct index when color disabled", () => {
    const palette = resolveExpertPalette({ NO_COLOR: "1" });
    expect(palette.indexOf("alice")).toBe(expertColorIndex("alice"));
  });
});
