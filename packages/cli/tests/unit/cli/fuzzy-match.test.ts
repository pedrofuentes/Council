/**
 * Tests for `src/cli/fuzzy-match.ts` — Levenshtein distance utility
 * and suggestion function for slug typos.
 *
 * RED at this commit: src/cli/fuzzy-match.ts does not exist.
 */
import { describe, expect, it } from "vitest";

import { levenshtein, suggestMatch } from "../../../src/cli/fuzzy-match.js";

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
  });

  it("returns the length of the other string when one is empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("xyz", "")).toBe(3);
  });

  it("handles single character difference (substitution)", () => {
    expect(levenshtein("cat", "car")).toBe(1);
  });

  it("handles insertion", () => {
    expect(levenshtein("ct", "cto")).toBe(1);
  });

  it("handles deletion", () => {
    expect(levenshtein("cto", "ct")).toBe(1);
  });

  it("handles multiple edits", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  it("is case-sensitive", () => {
    expect(levenshtein("ABC", "abc")).toBe(3);
  });
});

describe("suggestMatch", () => {
  const candidates = ["cto", "architect", "security", "frontend", "backend"];

  it("suggests the closest match for a close typo", () => {
    const result = suggestMatch("ct", candidates);
    expect(result).toEqual(["cto"]);
  });

  it("suggests multiple matches when distances are equal", () => {
    const result = suggestMatch("frotend", ["frontend", "backend"]);
    expect(result).toEqual(["frontend"]);
  });

  it("returns empty array when no candidate is close enough", () => {
    const result = suggestMatch("xyzxyzxyz", candidates);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty candidates list", () => {
    const result = suggestMatch("cto", []);
    expect(result).toEqual([]);
  });

  it("uses a max distance threshold (default: 3)", () => {
    // "abc" → "security" is distance 7, should not match
    const result = suggestMatch("abc", ["security"]);
    expect(result).toEqual([]);
  });

  it("returns exact match as suggestion if present", () => {
    const result = suggestMatch("cto", candidates);
    expect(result).toEqual(["cto"]);
  });
});
