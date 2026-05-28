/**
 * Tests for the shared `truncatePrompt` utility used by debate
 * header renderers to keep long topics from flooding the terminal.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROMPT_DISPLAY_MAX,
  truncatePrompt,
} from "../../../../src/cli/renderers/truncate-prompt.js";

describe("truncatePrompt", () => {
  it("returns short prompts unchanged", () => {
    expect(truncatePrompt("short topic")).toBe("short topic");
  });

  it("returns the empty string unchanged", () => {
    expect(truncatePrompt("")).toBe("");
  });

  it("returns a prompt of exactly the default max length unchanged", () => {
    const exact = "a".repeat(DEFAULT_PROMPT_DISPLAY_MAX);
    expect(truncatePrompt(exact)).toBe(exact);
    expect(truncatePrompt(exact)).not.toMatch(/\.{3}$/);
  });

  it("truncates prompts longer than the default max and appends an ellipsis", () => {
    const long = "a".repeat(DEFAULT_PROMPT_DISPLAY_MAX + 50);
    const out = truncatePrompt(long);
    expect(out.endsWith("...")).toBe(true);
    expect(out).toBe("a".repeat(DEFAULT_PROMPT_DISPLAY_MAX) + "...");
  });

  it("defaults to a 200-character limit", () => {
    expect(DEFAULT_PROMPT_DISPLAY_MAX).toBe(200);
  });

  it("respects a custom maxLength option", () => {
    expect(truncatePrompt("abcdefghij", { maxLength: 5 })).toBe("abcde...");
  });

  it("does not append an ellipsis when input length equals the custom maxLength", () => {
    expect(truncatePrompt("abcde", { maxLength: 5 })).toBe("abcde");
  });

  it("does not split a surrogate-pair emoji straddling the truncation boundary", () => {
    // "😀" is U+1F600, encoded as a UTF-16 surrogate pair (length 2 in JS strings).
    // With maxLength=5, naive String#slice(0, 5) on "aaaa😀bbbb" would cut the
    // emoji in half and yield an invalid lone surrogate ("aaaa\uD83D...").
    // Truncation must operate on Unicode code points so the emoji is either
    // kept intact or dropped entirely.
    const input = "aaaa\u{1F600}bbbb";
    const out = truncatePrompt(input, { maxLength: 5 });
    expect(out).toBe("aaaa\u{1F600}...");
    // Guard against lone surrogates appearing in the output.
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("truncates by code points rather than UTF-16 code units for multi-emoji input", () => {
    // Five emoji, each a surrogate pair → string .length is 10.
    // Truncating to 3 code points should yield 3 emoji + "...", not 3 UTF-16
    // code units (which would split the second emoji).
    const input = "\u{1F600}\u{1F601}\u{1F602}\u{1F603}\u{1F604}";
    expect(truncatePrompt(input, { maxLength: 3 })).toBe(
      "\u{1F600}\u{1F601}\u{1F602}...",
    );
  });

  it("counts a ZWJ family emoji as a single grapheme cluster", () => {
    // "👨‍👩‍👧" is U+1F468 ZWJ U+1F469 ZWJ U+1F467 — 5 code points, 1 grapheme.
    // Padding three ASCII chars + the family = 4 graphemes. With maxLength=4
    // the whole string should fit unchanged; with maxLength=3 only "aaa..."
    // should be returned (the family must not be split mid-cluster).
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(truncatePrompt("aaa" + family, { maxLength: 4 })).toBe(
      "aaa" + family,
    );
    expect(truncatePrompt("aaa" + family, { maxLength: 3 })).toBe("aaa...");
  });

  it("does not split a ZWJ family emoji that straddles the truncation boundary", () => {
    // With code-point slicing this would cut the family between the man and
    // the first ZWJ, leaving an orphaned ZWJ + woman + ZWJ + girl tail.
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const input = "ab" + family + "cd";
    const out = truncatePrompt(input, { maxLength: 2 });
    expect(out).toBe("ab...");
    // Output must not begin a ZWJ sequence mid-cluster.
    expect(out).not.toContain("\u200D");
  });

  it("counts a regional-indicator flag as a single grapheme cluster", () => {
    // "🇺🇸" = U+1F1FA U+1F1F8 — 2 code points, 1 grapheme.
    const flag = "\u{1F1FA}\u{1F1F8}";
    expect(truncatePrompt("ab" + flag + "cd", { maxLength: 3 })).toBe(
      "ab" + flag + "...",
    );
  });

  it("does not split a regional-indicator flag across the truncation boundary", () => {
    const flag = "\u{1F1FA}\u{1F1F8}";
    const out = truncatePrompt("ab" + flag + "cd", { maxLength: 2 });
    expect(out).toBe("ab...");
    // No lone regional indicator should appear in the output.
    expect(out).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]/u);
  });

  it("keeps a base character and its combining mark together as one grapheme", () => {
    // "e" + U+0301 (combining acute) = "é" — 2 code points, 1 grapheme.
    const eAcute = "e\u0301";
    expect(truncatePrompt("ab" + eAcute + "cd", { maxLength: 3 })).toBe(
      "ab" + eAcute + "...",
    );
    // Truncating just before the cluster must drop it whole, not leave a
    // dangling combining mark at the start of the next cluster.
    const out = truncatePrompt("ab" + eAcute + "cd", { maxLength: 2 });
    expect(out).toBe("ab...");
    expect(out).not.toContain("\u0301");
  });
});
