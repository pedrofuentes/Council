/**
 * Tests for the symbols module — Unicode/ASCII symbol sets.
 *
 * RED at this commit: src/cli/renderers/symbols.ts does not exist.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getSymbols } from "../../../../src/cli/renderers/symbols.js";

describe("getSymbols", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns unicode symbols by default", () => {
    delete process.env.NO_COLOR;
    delete process.env.TERM;
    delete process.env.COUNCIL_ASCII;

    const s = getSymbols();
    expect(s.panel).toBe("🏛️");
    expect(s.roundRule).toBe("━");
    expect(s.separator).toBe("─");
    expect(s.headerRule).toBe("═");
    expect(s.cursor).toBe("▋");
    expect(s.pass).toBe("✅");
    expect(s.fail).toBe("❌");
    expect(s.warn).toBe("⚠");
    expect(s.info).toBe("ℹ");
    expect(s.error).toBe("✗");
    expect(s.bullet).toBe("•");
    expect(s.complete).toBe("✓");
  });

  it("returns ASCII symbols when ascii=true", () => {
    const s = getSymbols(true);
    expect(s.panel).toBe("[Panel]");
    expect(s.roundRule).toBe("-");
    expect(s.separator).toBe("-");
    expect(s.headerRule).toBe("=");
    expect(s.cursor).toBe("|");
    expect(s.pass).toBe("[OK]");
    expect(s.fail).toBe("[FAIL]");
    expect(s.warn).toBe("[WARN]");
    expect(s.info).toBe("[i]");
    expect(s.error).toBe("[x]");
    expect(s.bullet).toBe("*");
    expect(s.complete).toBe("[DONE]");
  });

  it("auto-detects ASCII when NO_COLOR is set", () => {
    process.env.NO_COLOR = "1";
    const s = getSymbols();
    expect(s.panel).toBe("[Panel]");
  });

  it("auto-detects ASCII when TERM=dumb", () => {
    delete process.env.NO_COLOR;
    process.env.TERM = "dumb";
    const s = getSymbols();
    expect(s.panel).toBe("[Panel]");
  });

  it("auto-detects ASCII when COUNCIL_ASCII=1", () => {
    delete process.env.NO_COLOR;
    delete process.env.TERM;
    process.env.COUNCIL_ASCII = "1";
    const s = getSymbols();
    expect(s.panel).toBe("[Panel]");
  });

  it("explicit false overrides env detection", () => {
    process.env.NO_COLOR = "1";
    const s = getSymbols(false);
    expect(s.panel).toBe("🏛️");
  });

  it("symbol set is readonly (frozen)", () => {
    const s = getSymbols();
    expect(Object.isFrozen(s)).toBe(true);
  });
});
