import { describe, expect, it } from "vitest";

import { resolveTheme } from "../../../src/tui/theme/tokens.js";

describe("resolveTheme", () => {
  it("applies color to every token when enabled", () => {
    const t = resolveTheme({ FORCE_COLOR: "3" });
    expect(t.enabled).toBe(true);
    for (const fn of [t.accent, t.muted, t.error, t.warn, t.success]) {
      expect(fn("x")).not.toBe("x");
      expect(fn("x")).toContain("x");
    }
  });

  it("is identity for every token under NO_COLOR", () => {
    const t = resolveTheme({ NO_COLOR: "1" });
    expect(t.enabled).toBe(false);
    for (const fn of [t.accent, t.muted, t.error, t.warn, t.success]) {
      expect(fn("x")).toBe("x");
    }
  });

  it("is identity for every token under TERM=dumb", () => {
    const t = resolveTheme({ TERM: "dumb" });
    expect(t.enabled).toBe(false);
    for (const fn of [t.accent, t.muted, t.error, t.warn, t.success]) {
      expect(fn("m")).toBe("m");
    }
  });
});
