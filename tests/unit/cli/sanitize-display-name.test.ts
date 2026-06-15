/**
 * Tests for `sanitizeDisplayName()` — sanitizes expert display names at
 * creation time to prevent control/bidi/zero-width character injection and
 * enforce reasonable length limits. Applied on `council expert create --name`
 * and `council expert edit` to ensure display names render safely in tables,
 * transcripts, and LLM prompts.
 */
import { describe, expect, it } from "vitest";

import { CliUserError } from "../../../src/cli/cli-user-error.js";
import { sanitizeDisplayName } from "../../../src/cli/sanitize-display-name.js";

describe("sanitizeDisplayName", () => {
  it("returns plain ASCII name unchanged", () => {
    expect(sanitizeDisplayName("Security Expert")).toBe("Security Expert");
  });

  it("preserves valid emoji in display names", () => {
    // Emoji are valid printable Unicode — not control characters
    expect(sanitizeDisplayName("🚀 Rocket Boss")).toBe("🚀 Rocket Boss");
    expect(sanitizeDisplayName("Dahlia Renner (CTO) 📊")).toBe("Dahlia Renner (CTO) 📊");
  });

  it("strips ANSI control sequences from name", () => {
    const dirty = "\x1B[31mRed Name\x1B[0m";
    expect(sanitizeDisplayName(dirty)).toBe("Red Name");
  });

  it("strips bidi controls (CVE-2021-42574 Trojan Source)", () => {
    // U+202E = RIGHT-TO-LEFT OVERRIDE
    const malicious = "Admin\u202EtseT";
    expect(sanitizeDisplayName(malicious)).toBe("AdmintseT");
  });

  it("strips all bidi embedding and isolate controls", () => {
    const dirty = "name\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069test";
    expect(sanitizeDisplayName(dirty)).toBe("nametest");
  });

  it("strips zero-width characters", () => {
    // U+200B = ZERO WIDTH SPACE
    // U+200C = ZERO WIDTH NON-JOINER
    // U+200D = ZERO WIDTH JOINER
    // U+FEFF = ZERO WIDTH NO-BREAK SPACE (BOM)
    const dirty = "Name\u200B\u200C\u200D\uFEFFTest";
    expect(sanitizeDisplayName(dirty)).toBe("NameTest");
  });

  it("collapses multiple spaces to single space", () => {
    expect(sanitizeDisplayName("Alice    Bob")).toBe("Alice Bob");
  });

  it("collapses newlines and tabs to single spaces", () => {
    expect(sanitizeDisplayName("Alice\n\nBob")).toBe("Alice Bob");
    expect(sanitizeDisplayName("Alice\t\tBob")).toBe("Alice Bob");
    expect(sanitizeDisplayName("Alice\r\nBob")).toBe("Alice Bob");
  });

  it("collapses mixed whitespace to single spaces", () => {
    expect(sanitizeDisplayName("Alice \n\t Bob")).toBe("Alice Bob");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeDisplayName("  Alice Bob  ")).toBe("Alice Bob");
    expect(sanitizeDisplayName("\n\tAlice\t\n")).toBe("Alice");
  });

  it("caps length at 80 characters", () => {
    const longName = "A".repeat(100);
    const result = sanitizeDisplayName(longName);
    expect(result).toBe("A".repeat(80));
    expect(result.length).toBe(80);
  });

  it("caps length at 80 characters preserving word boundaries when possible", () => {
    const longName = "Chief Technology Officer with extensive experience in " + "x".repeat(50);
    const result = sanitizeDisplayName(longName);
    expect(result.length).toBe(80);
    expect(result).toBe("Chief Technology Officer with extensive experience in " + "x".repeat(26));
  });

  it("throws CliUserError when name becomes empty after sanitization", () => {
    expect(() => sanitizeDisplayName("   ")).toThrow(CliUserError);
    expect(() => sanitizeDisplayName("   ")).toThrow(
      /Display name cannot be empty or consist only of whitespace/,
    );
  });

  it("throws CliUserError when name is only control characters", () => {
    const allControls = "\x1B[31m\u202E\u200B";
    expect(() => sanitizeDisplayName(allControls)).toThrow(CliUserError);
  });

  it("handles complex real-world malicious input", () => {
    // Combination: ANSI colors, bidi overrides, zero-width, newlines
    const malicious = "\x1B[31m🚀\u202E Rocket\n\n\u200B Boss \x1B[0m\u202C";
    expect(sanitizeDisplayName(malicious)).toBe("🚀 Rocket Boss");
  });

  it("preserves accented and non-Latin characters", () => {
    expect(sanitizeDisplayName("José García")).toBe("José García");
    expect(sanitizeDisplayName("日本語 Expert")).toBe("日本語 Expert");
    expect(sanitizeDisplayName("Café Manager")).toBe("Café Manager");
  });

  it("handles empty string input", () => {
    expect(() => sanitizeDisplayName("")).toThrow(CliUserError);
  });

  it("handles name exactly at 80 char limit", () => {
    const exactly80 = "A".repeat(80);
    expect(sanitizeDisplayName(exactly80)).toBe(exactly80);
  });
});
