/**
 * Tests for cost estimation.
 *
 * Pure functions — no DB, no engine, no I/O. Used by:
 *   - `council convene --estimate` (CLI command, future PR)
 *   - The orchestrator's `cost.update` events for live progress display
 *   - `council doctor` (sanity-check user's plan against expected cost)
 *
 * RED at this commit: src/core/cost.ts does not exist.
 */
import { describe, expect, it } from "vitest";

import {
  estimateDebateCost,
  formatCostBreakdown,
  type CostEstimate,
} from "../../../src/core/cost.js";

describe("estimateDebateCost", () => {
  it("3 experts × 4 rounds + 4 moderator turns = 16 premium requests", () => {
    const estimate: CostEstimate = estimateDebateCost({ maxRounds: 4, mode: "freeform" }, 3);
    expect(estimate.premiumRequests).toBe(16);
    expect(estimate.breakdown).toContainEqual({ phase: "Expert turns", count: 12 });
    expect(estimate.breakdown).toContainEqual({ phase: "Moderator summaries", count: 4 });
  });

  it("counts 0 moderator turns when moderator is disabled", () => {
    const estimate = estimateDebateCost(
      { maxRounds: 4, mode: "freeform", includeModerator: false },
      3,
    );
    expect(estimate.premiumRequests).toBe(12);
    expect(estimate.breakdown).toContainEqual({ phase: "Expert turns", count: 12 });
    expect(estimate.breakdown.some((b) => b.phase === "Moderator summaries")).toBe(false);
  });

  it("handles edge case: 1 round, 2 experts", () => {
    const estimate = estimateDebateCost({ maxRounds: 1, mode: "freeform" }, 2);
    expect(estimate.premiumRequests).toBe(3); // 2 expert + 1 moderator
  });

  it("breakdown counts sum exactly to premiumRequests", () => {
    const estimate = estimateDebateCost({ maxRounds: 6, mode: "structured" }, 4);
    const sum = estimate.breakdown.reduce((acc, b) => acc + b.count, 0);
    expect(sum).toBe(estimate.premiumRequests);
  });

  it("rejects non-positive expert count", () => {
    expect(() => estimateDebateCost({ maxRounds: 4, mode: "freeform" }, 0)).toThrow(/expert/i);
    expect(() => estimateDebateCost({ maxRounds: 4, mode: "freeform" }, -1)).toThrow(/expert/i);
  });

  it("rejects non-positive maxRounds", () => {
    expect(() => estimateDebateCost({ maxRounds: 0, mode: "freeform" }, 3)).toThrow(/round/i);
  });
});

describe("formatCostBreakdown", () => {
  it("renders a multi-line plain-text breakdown ending with the total", () => {
    const estimate: CostEstimate = {
      premiumRequests: 16,
      breakdown: [
        { phase: "Expert turns", count: 12 },
        { phase: "Moderator summaries", count: 4 },
      ],
    };
    const formatted = formatCostBreakdown(estimate);
    expect(formatted).toContain("Expert turns");
    expect(formatted).toContain("12");
    expect(formatted).toContain("Moderator summaries");
    expect(formatted).toContain("4");
    expect(formatted).toMatch(/total.*16/i);
  });
});
