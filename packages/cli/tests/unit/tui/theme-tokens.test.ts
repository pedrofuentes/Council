import { describe, expect, it } from "vitest";

import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const enabledEnv = { FORCE_COLOR: "1" };
const noColorEnv = { NO_COLOR: "1" };
const dumbTermEnv = { TERM: "dumb" };

describe("resolveTheme — semantic roles", () => {
  it("all roles are functions and enabled=true with color on", () => {
    const t = resolveTheme(enabledEnv);
    expect(t.enabled).toBe(true);
    for (const fn of [t.accent, t.muted, t.error, t.warn, t.success, t.primary, t.secondary, t.info]) {
      expect(typeof fn).toBe("function");
    }
  });

  it("all roles produce output containing the input string when color on", () => {
    const t = resolveTheme(enabledEnv);
    for (const fn of [t.accent, t.muted, t.error, t.warn, t.success, t.primary, t.secondary, t.info]) {
      expect(fn("hello")).toContain("hello");
    }
  });

  it("all roles are identity and enabled=false under NO_COLOR=1", () => {
    const t = resolveTheme(noColorEnv);
    expect(t.enabled).toBe(false);
    for (const fn of [t.accent, t.muted, t.error, t.warn, t.success, t.primary, t.secondary, t.info]) {
      expect(fn("x")).toBe("x");
    }
  });

  it("all roles are identity and enabled=false under TERM=dumb", () => {
    const t = resolveTheme(dumbTermEnv);
    expect(t.enabled).toBe(false);
    for (const fn of [t.accent, t.muted, t.error, t.warn, t.success, t.primary, t.secondary, t.info]) {
      expect(fn("y")).toBe("y");
    }
  });

  it("NO_COLOR empty string does NOT disable color", () => {
    const t = resolveTheme({ NO_COLOR: "" });
    expect(t.enabled).toBe(true);
  });

  it("existing roles (accent, muted, etc.) still work after extension", () => {
    const t = resolveTheme(enabledEnv);
    expect(typeof t.accent).toBe("function");
    expect(typeof t.muted).toBe("function");
    expect(typeof t.error).toBe("function");
    expect(typeof t.warn).toBe("function");
    expect(typeof t.success).toBe("function");
  });
});
