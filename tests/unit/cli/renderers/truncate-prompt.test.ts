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
});
