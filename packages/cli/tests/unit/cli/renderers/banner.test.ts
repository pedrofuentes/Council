/**
 * Tests for the banner renderer — the "Council" wordmark startup banner.
 *
 * RED at this commit: src/cli/renderers/banner.ts does not exist yet.
 */
import { describe, expect, it } from "vitest";

import { renderBanner, renderCompactVersionLine } from "../../../../src/cli/renderers/banner.js";

const FULL_BLOCK = "\u2588"; // █
const VERSION = "0.3.0";

describe("renderCompactVersionLine", () => {
  it("returns a plain, single-line 'Council vX.Y.Z' string", () => {
    const line = renderCompactVersionLine(VERSION);
    expect(line).toBe("Council v0.3.0");
    expect(line).not.toContain(FULL_BLOCK);
    expect(line).not.toContain("\u001b[");
    expect(line).not.toContain("\n");
  });

  it("interpolates the supplied version", () => {
    expect(renderCompactVersionLine("1.2.3")).toBe("Council v1.2.3");
  });
});

describe("renderBanner", () => {
  const base = { version: VERSION, isTTY: true, columns: 120 } as const;

  it("falls back to the compact line when not a TTY", () => {
    const out = renderBanner({ ...base, isTTY: false, colorLevel: 3 });
    expect(out).toBe("Council v0.3.0");
    expect(out).not.toContain(FULL_BLOCK);
  });

  it("falls back to the compact line when the terminal is too narrow", () => {
    const out = renderBanner({ ...base, columns: 50, colorLevel: 3 });
    expect(out).toBe("Council v0.3.0");
    expect(out).not.toContain(FULL_BLOCK);
  });

  it("renders a plain-text banner (no block art, no color) in ASCII mode", () => {
    const out = renderBanner({ ...base, ascii: true, colorLevel: 3 });
    expect(out).not.toContain(FULL_BLOCK);
    expect(out).not.toContain("\u001b[");
    expect(out).toContain("Council");
    expect(out).toContain("Persistent AI expert panels");
    expect(out).toContain("v0.3.0");
    expect(out).not.toContain("\u00b7"); // ASCII mode avoids the middle dot
  });

  it("renders uncolored block art when color level is 0", () => {
    const out = renderBanner({ ...base, ascii: false, colorLevel: 0 });
    expect(out).toContain(FULL_BLOCK);
    expect(out).not.toContain("\u001b[");
    expect(out).toContain("v0.3.0");
    // 5 art rows + a subtitle line
    expect(out.split("\n").length).toBeGreaterThanOrEqual(6);
  });

  it("renders 16-color block art at level 1 (no truecolor sequences)", () => {
    const out = renderBanner({ ...base, ascii: false, colorLevel: 1 });
    expect(out).toContain(FULL_BLOCK);
    expect(out).toContain("\u001b[");
    expect(out).not.toContain("38;2;");
  });

  it("renders a truecolor gradient at level 3", () => {
    const out = renderBanner({ ...base, ascii: false, colorLevel: 3 });
    expect(out).toContain(FULL_BLOCK);
    expect(out).toContain("\u001b[38;2;");
    // gradient => more than one distinct truecolor sequence
    const triples = out.match(/38;2;\d+;\d+;\d+m/g) ?? [];
    expect(new Set(triples).size).toBeGreaterThan(1);
  });

  it("includes the default subtitle with a middle dot in unicode mode", () => {
    const out = renderBanner({ ...base, ascii: false, colorLevel: 0 });
    expect(out).toContain("Persistent AI expert panels");
    expect(out).toContain("\u00b7");
  });

  it("honours a custom subtitle", () => {
    const out = renderBanner({ ...base, ascii: false, colorLevel: 0, subtitle: "Custom tagline" });
    expect(out).toContain("Custom tagline");
    expect(out).not.toContain("Persistent AI expert panels");
  });

  it("interpolates the version into the banner subtitle", () => {
    const out = renderBanner({ ...base, version: "9.9.9", ascii: false, colorLevel: 0 });
    expect(out).toContain("v9.9.9");
  });
});
