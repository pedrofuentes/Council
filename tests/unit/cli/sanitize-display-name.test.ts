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

  // --- Regression (PR #1035 R1): complete Unicode Bidi_Control + default-ignorable coverage ---

  it("strips the remaining Unicode Bidi_Control marks (ALM, LRM, RLM)", () => {
    // U+061C ARABIC LETTER MARK, U+200E LEFT-TO-RIGHT MARK, U+200F RIGHT-TO-LEFT MARK.
    // These complete Bidi_Control coverage beyond the overrides/isolates already
    // stripped by stripControlChars, closing the rest of the Trojan Source vector.
    const dirty = "Admin\u061C\u200E\u200FName";
    expect(sanitizeDisplayName(dirty)).toBe("AdminName");
  });

  it("strips every Unicode Bidi_Control code point", () => {
    // Full Bidi_Control set: ALM + LRM/RLM + embeddings/overrides + isolates.
    const dirty =
      "a\u061Cb\u200Ec\u200Fd\u202Ae\u202Bf\u202Cg\u202Dh\u202Ei\u2066j\u2067k\u2068l\u2069m";
    expect(sanitizeDisplayName(dirty)).toBe("abcdefghijklm");
  });

  it("strips default-ignorable invisible format characters", () => {
    // U+00AD SOFT HYPHEN, U+2060 WORD JOINER, U+2063 INVISIBLE SEPARATOR.
    const dirty = "Soft\u00ADHyphen\u2060Word\u2063Sep";
    expect(sanitizeDisplayName(dirty)).toBe("SoftHyphenWordSep");
  });

  it("strips Hangul filler characters", () => {
    // U+115F, U+1160, U+3164, U+FFA0 — invisible/blank Hangul fillers.
    const dirty = "Name\u115F\u1160\u3164\uFFA0Test";
    expect(sanitizeDisplayName(dirty)).toBe("NameTest");
  });

  it("strips Unicode TAG characters (U+E0000–U+E007F)", () => {
    // Tag chars are invisible and can smuggle hidden ASCII-like payloads.
    const dirty = "Hidden\u{E0041}\u{E0042}\u{E007F}Tag";
    expect(sanitizeDisplayName(dirty)).toBe("HiddenTag");
  });

  it("preserves emoji that depend on variation selector U+FE0F", () => {
    // ❤️ = U+2764 HEAVY BLACK HEART + U+FE0F VARIATION SELECTOR-16. Stripping
    // VS16 would corrupt the emoji, so the variation-selector block must survive.
    expect(sanitizeDisplayName("I \u2764\uFE0F Council")).toBe("I \u2764\uFE0F Council");
    expect(sanitizeDisplayName("\u2699\uFE0F Settings")).toBe("\u2699\uFE0F Settings");
  });

  it("strips hidden marks while preserving emoji in the same input", () => {
    // Keep 🚀 and ❤️(VS16); strip leading ALM, a word joiner, and a tag char.
    const dirty = "\u061C🚀 Team \u2764\uFE0F\u2060\u{E0041}";
    expect(sanitizeDisplayName(dirty)).toBe("🚀 Team \u2764\uFE0F");
  });
});
