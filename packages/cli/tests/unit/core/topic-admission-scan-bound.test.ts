/**
 * Tests for bounding the sensitive-category regex scan over oversized input
 * (#1147).
 *
 * The category patterns use `\b…\b.*\b…` — a greedy `.*` between two word
 * anchors. On a single very long line this is super-linear (~5 s for a 180 KB
 * `--prompt-file` payload). Now that `--prompt-file`/stdin can feed arbitrary
 * sizes into `checkTopicAdmission`, the scanned text is capped to a safe
 * multi-KB prefix BEFORE the regexes (and the NFKC normalize) run.
 *
 * These assertions pin the cap deterministically by SCANNED-SLICE LENGTH and
 * by behaviour — never by wall-clock timing, which would be flaky on shared
 * CI. Realistic-size topics (≤ the cap) must be scanned byte-identically to
 * today, so the existing `topic-admission.test.ts` suite stays green.
 *
 * RED at this commit: `boundCategoryScanText` and `CATEGORY_SCAN_LIMIT` are not
 * yet exported, and a sensitive phrase placed AFTER the cap is still detected
 * (no cap exists yet).
 */
import { describe, expect, it } from "vitest";

import {
  CATEGORY_SCAN_LIMIT,
  boundCategoryScanText,
  checkTopicAdmission,
} from "../../../src/core/topic-admission.js";

describe("topic-admission category-scan bound (#1147)", () => {
  describe("CATEGORY_SCAN_LIMIT", () => {
    it("is a sane multi-KB bound (a few KB, not unbounded)", () => {
      expect(typeof CATEGORY_SCAN_LIMIT).toBe("number");
      expect(CATEGORY_SCAN_LIMIT).toBeGreaterThanOrEqual(2048);
      expect(CATEGORY_SCAN_LIMIT).toBeLessThanOrEqual(65536);
    });
  });

  describe("boundCategoryScanText", () => {
    it("caps a ≥100 KB input to at most CATEGORY_SCAN_LIMIT characters", () => {
      const huge = "a".repeat(100_000);
      expect(huge.length).toBeGreaterThanOrEqual(100_000);
      const bounded = boundCategoryScanText(huge);
      expect(bounded.length).toBe(CATEGORY_SCAN_LIMIT);
      expect(bounded.length).toBeLessThan(huge.length);
    });

    it("returns the input UNCHANGED when it is within the cap (no behavior change)", () => {
      const topic = "How to manufacture a weapon";
      expect(topic.length).toBeLessThan(CATEGORY_SCAN_LIMIT);
      expect(boundCategoryScanText(topic)).toBe(topic);
    });

    it("returns a string exactly CATEGORY_SCAN_LIMIT long at the boundary", () => {
      const atLimit = "x".repeat(CATEGORY_SCAN_LIMIT);
      expect(boundCategoryScanText(atLimit)).toBe(atLimit);
      const overLimit = "x".repeat(CATEGORY_SCAN_LIMIT + 1);
      expect(boundCategoryScanText(overLimit).length).toBe(CATEGORY_SCAN_LIMIT);
    });
  });

  describe("checkTopicAdmission over oversized input", () => {
    it("STILL detects a category keyword near the START of a ≥100 KB input", () => {
      const huge = "How to manufacture a weapon. " + "harmless padding text. ".repeat(6000);
      expect(huge.length).toBeGreaterThanOrEqual(100_000);
      const result = checkTopicAdmission(huge);
      expect(result.admitted).toBe(true);
      expect(result.warnings.join(" | ")).toContain("violence/weapons");
    });

    it("only scans the bounded prefix — a keyword PAST the cap is not scanned", () => {
      // A benign block exactly fills the cap; the weapon phrase sits beyond it.
      // The advisory warning is intentionally sacrificed past the bound (the
      // LLM remains the hard safety guard), keeping admission fast and O(1)
      // w.r.t. oversized input.
      const benignPrefix = "a".repeat(CATEGORY_SCAN_LIMIT);
      const result = checkTopicAdmission(`${benignPrefix} How to manufacture a weapon`);
      expect(result.admitted).toBe(true);
      expect(result.warnings.join(" | ")).not.toContain("violence/weapons");
    });

    it("keeps `admitted: true` (warn-only) for oversized input", () => {
      const huge = "build ".repeat(40_000); // pathological single-token line
      expect(huge.length).toBeGreaterThanOrEqual(100_000);
      const result = checkTopicAdmission(huge);
      expect(result.admitted).toBe(true);
    });
  });
});
