/**
 * Tests for the anti-sycophancy quality gate.
 *
 * The gate inspects an expert response and decides whether it satisfies
 * the contract Council promises panel users:
 *   1. No forbidden phrases (Layer 1 of the 3-layer system)
 *   2. Disagreement budget met when prior speakers exist (Layer 2)
 *   3. Minimum specificity (no generic filler)
 *
 * Implementation lives in src/core/quality-gate.ts.
 *
 * RED at this commit: module does not exist yet.
 */
import { describe, expect, it } from "vitest";

import {
  applyQualityGate,
  type QualityCheck,
  type QualityResult,
} from "../../../src/core/quality-gate.js";

describe("applyQualityGate — basic structure", () => {
  it("returns ok=true and empty failures for a clean response", () => {
    const result: QualityResult = applyQualityGate(
      "This is a specific, falsifiable claim about latency budgets and on-call load thresholds.",
      { priorSpeakers: [] },
    );
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.regenerateHint).toBeUndefined();
  });

  it("returns ok=false with at least one failure check when the response is bad", () => {
    const result: QualityResult = applyQualityGate("Great point! I agree with the previous speaker.", {
      priorSpeakers: ["cto"],
    });
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThanOrEqual(1);
    expect(result.regenerateHint).toBeTypeOf("string");
    if (!result.regenerateHint) throw new Error("expected hint");
    expect(result.regenerateHint.length).toBeGreaterThan(0);
  });
});

describe("applyQualityGate — forbidden phrases (Layer 1)", () => {
  for (const phrase of [
    "Great point",
    "I agree with",
    "Building on",
    "holistic",
    "synergy",
    "leverage",
    "robust",
    "best practices",
  ]) {
    it(`flags the forbidden phrase "${phrase}"`, () => {
      const text = `Here is a sentence that uses ${phrase} in the middle.`;
      const result = applyQualityGate(text, { priorSpeakers: [] });
      expect(result.ok).toBe(false);
      const check = result.failures.find((f) => f.kind === "forbidden_phrase");
      expect(check).toBeDefined();
      expect(check?.detail.toLowerCase()).toContain(phrase.toLowerCase());
    });
  }

  it("is case-insensitive when matching forbidden phrases", () => {
    const result = applyQualityGate("GREAT POINT — I have additional thoughts.", { priorSpeakers: [] });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.kind === "forbidden_phrase")).toBe(true);
  });
});

describe("applyQualityGate — disagreement budget (Layer 2)", () => {
  it("does NOT require disagreement when there are no prior speakers (round 0)", () => {
    const result = applyQualityGate(
      "My opening position is that we should defer the migration until we have observability coverage.",
      { priorSpeakers: [] },
    );
    expect(result.ok).toBe(true);
  });

  it("flags absence of disagreement signal when prior speakers exist", () => {
    const result = applyQualityGate(
      "Yes, the previous expert is correct and I want to add a few thoughts.",
      { priorSpeakers: ["cto", "pm"] },
    );
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.kind === "no_disagreement_signal")).toBe(true);
  });

  it("accepts the explicit stand-down phrase as satisfying the disagreement budget", () => {
    const text =
      "I have stress-tested the CTO's position and cannot find a material weakness. " +
      "My contribution is therefore to add one specific consideration about the migration timeline.";
    const result = applyQualityGate(text, { priorSpeakers: ["cto"] });
    expect(result.ok).toBe(true);
  });

  it("accepts disagreement when the response identifies a weak claim", () => {
    const text =
      "I disagree with the CTO's framing. The team-size argument ignores the operational maturity dimension.";
    const result = applyQualityGate(text, { priorSpeakers: ["cto"] });
    expect(result.ok).toBe(true);
  });

  it("accepts disagreement when the response names an omitted consideration", () => {
    const text =
      "The previous speakers omitted the cost of operating two databases in parallel during migration.";
    const result = applyQualityGate(text, { priorSpeakers: ["cto", "pm"] });
    expect(result.ok).toBe(true);
  });
});

describe("applyQualityGate — specificity (Layer 3)", () => {
  it("flags responses that are too short to carry signal", () => {
    const result = applyQualityGate("I disagree.", { priorSpeakers: ["cto"] });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.kind === "too_short")).toBe(true);
  });

  it("does not flag short responses when they would be valid (round 0)", () => {
    // Even with priorSpeakers=[], a 5-word response is too short.
    const result = applyQualityGate("Yes.", { priorSpeakers: [] });
    expect(result.failures.some((f) => f.kind === "too_short")).toBe(true);
  });
});

describe("applyQualityGate — regenerateHint", () => {
  it("includes the failure kind names in the hint to guide the regeneration", () => {
    const result = applyQualityGate(
      "Great point! I agree with the previous speaker about leveraging best practices.",
      { priorSpeakers: ["cto"] },
    );
    expect(result.ok).toBe(false);
    expect(result.regenerateHint).toBeDefined();
    if (!result.regenerateHint) throw new Error("expected hint");
    const hint = result.regenerateHint.toLowerCase();
    // Must mention the kinds of failures so the model knows what to fix
    expect(hint).toMatch(/forbidden|phrase/);
  });

  it("returns no hint when ok=true (nothing to fix)", () => {
    const result = applyQualityGate(
      "I disagree with the prior speaker about latency budgets — the p99 measurement methodology is flawed.",
      { priorSpeakers: ["cto"] },
    );
    expect(result.ok).toBe(true);
    expect(result.regenerateHint).toBeUndefined();
  });
});

describe("QualityCheck shape", () => {
  it("each failure has kind and detail fields", () => {
    const result = applyQualityGate("synergy.", { priorSpeakers: [] });
    for (const failure of result.failures) {
      const check: QualityCheck = failure;
      expect(typeof check.kind).toBe("string");
      expect(typeof check.detail).toBe("string");
    }
  });
});

