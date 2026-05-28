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
});
