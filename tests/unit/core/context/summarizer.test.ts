/**
 * Tests for the heuristic rolling summarizer (ROADMAP §2.6).
 *
 * `buildRollingSummary()` produces a compact summary of prior debate
 * turns so long debates do not overflow context windows. Until the
 * configured threshold is reached we return the empty string so the
 * orchestrator falls back to including verbatim turns.
 *
 * Heuristic-only — no LLM is invoked. The summary extracts each
 * expert's most recent first sentence as their position and surfaces
 * any disagreement signals it can detect with simple keyword matching.
 */
import { describe, expect, it } from "vitest";

import { buildRollingSummary } from "../../../../src/core/context/summarizer.js";
import type { PriorTurnRecord } from "../../../../src/core/moderator/strategy.js";

function turn(slug: string, round: number, content: string): PriorTurnRecord {
  return { expertSlug: slug, displayName: slug.toUpperCase(), content, round };
}

describe("buildRollingSummary — threshold gating", () => {
  it("returns empty string before the threshold", () => {
    const turns = [
      turn("cto", 0, "We should ship now. Speed wins."),
      turn("pm", 0, "Ship it. Iterate fast."),
    ];
    const out = buildRollingSummary(turns, 1, {
      summarizeAfterRound: 3,
      maxSummaryLength: 500,
    });
    expect(out).toBe("");
  });

  it("returns empty string for an empty turn list", () => {
    const out = buildRollingSummary([], 5, {
      summarizeAfterRound: 3,
      maxSummaryLength: 500,
    });
    expect(out).toBe("");
  });

  it("produces a non-empty summary once the threshold is reached", () => {
    const turns = [
      turn("cto", 0, "Ship the feature now."),
      turn("pm", 0, "Hold for one more week."),
      turn("cto", 1, "Speed beats polish here."),
      turn("pm", 1, "Quality concerns remain."),
      turn("cto", 2, "Risks are manageable."),
      turn("pm", 2, "Risks are still elevated."),
    ];
    const out = buildRollingSummary(turns, 3, {
      summarizeAfterRound: 3,
      maxSummaryLength: 500,
    });
    expect(out).not.toBe("");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("buildRollingSummary — content", () => {
  it("includes each participating expert's display name", () => {
    const turns = [
      turn("cto", 0, "Ship the feature."),
      turn("pm", 0, "Wait one more week."),
      turn("cto", 1, "Speed beats polish."),
      turn("pm", 1, "Quality concerns remain."),
      turn("cto", 2, "Risks are manageable."),
      turn("pm", 2, "Risks are still elevated."),
    ];
    const out = buildRollingSummary(turns, 3, {
      summarizeAfterRound: 3,
      maxSummaryLength: 500,
    });
    expect(out).toContain("CTO");
    expect(out).toContain("PM");
  });

  it("uses the first sentence of each expert's most recent turn", () => {
    const turns = [
      turn("cto", 0, "Old CTO opinion."),
      turn("cto", 2, "Latest CTO position. Some elaborating sentence."),
      turn("pm", 2, "Latest PM position. With elaboration too."),
    ];
    const out = buildRollingSummary(turns, 3, {
      summarizeAfterRound: 3,
      maxSummaryLength: 500,
    });
    expect(out).toContain("Latest CTO position");
    expect(out).toContain("Latest PM position");
    expect(out).not.toContain("Old CTO opinion");
  });

  it("identifies disagreements when keywords are present", () => {
    const turns = [
      turn("cto", 0, "Ship now."),
      turn("pm", 0, "I disagree with shipping today. We need more tests."),
      turn("cto", 2, "However, the data says risks are low. Ship now."),
      turn("pm", 2, "I disagree. Quality risks remain elevated."),
    ];
    const out = buildRollingSummary(turns, 3, {
      summarizeAfterRound: 3,
      maxSummaryLength: 1000,
    });
    expect(out.toLowerCase()).toMatch(/tension|disagree/);
  });

  it("respects maxSummaryLength by truncating output", () => {
    const longSentence = "A".repeat(2000);
    const turns = [
      turn("cto", 0, `${longSentence}. trailing.`),
      turn("pm", 0, `${longSentence}. trailing.`),
    ];
    const out = buildRollingSummary(turns, 5, {
      summarizeAfterRound: 3,
      maxSummaryLength: 200,
    });
    expect(out.length).toBeLessThanOrEqual(200);
  });
});
