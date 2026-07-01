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
    const result: QualityResult = applyQualityGate(
      "Great point! I agree with the previous speaker.",
      {
        priorSpeakers: ["cto"],
      },
    );
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
    const result = applyQualityGate("GREAT POINT — I have additional thoughts.", {
      priorSpeakers: [],
    });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.kind === "forbidden_phrase")).toBe(true);
  });
});

describe("applyQualityGate — narrowed 'echoing' phrase (Layer 1, issue #1506)", () => {
  // The forbidden-phrase entry was a bare "echoing" substring, which the
  // case-insensitive `.includes()` matcher over-applied to innocent prose
  // ("an echoing concern", "re-echoing"). The ban now targets only the
  // agreement-echo forms, so legitimate uses of the word must pass.
  const echoForbidden = (response: string): string[] =>
    applyQualityGate(response, { priorSpeakers: [] })
      .failures.filter(
        (f) => f.kind === "forbidden_phrase" && f.detail.toLowerCase().includes("echoing"),
      )
      .map((f) => f.detail);

  for (const text of [
    "This raises an echoing concern about cache invalidation that nobody on the team has actually addressed yet.",
    "The proposal risks building an echo chamber where every service simply repeats the same flawed latency assumption.",
    "Re-echoing through the distributed log, the duplicated event eventually corrupts the downstream read model under load.",
  ]) {
    it(`does NOT flag legitimate use: "${text.slice(0, 36)}…"`, () => {
      expect(echoForbidden(text)).toEqual([]);
    });
  }

  for (const text of [
    "Echoing the previous speaker, I think this captures the whole situation and there is nothing more to add here.",
    "Echoing your point about scalability, I completely agree the team has framed the tradeoffs in the right way.",
    "I'm just echoing what everyone has already said, but this really is a thorough and well-rounded plan overall.",
  ]) {
    it(`still flags performative agreement-echoing: "${text.slice(0, 36)}…"`, () => {
      expect(echoForbidden(text).length).toBeGreaterThan(0);
    });
  }
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

describe("applyQualityGate — negation bypass (Layer 2, issue #47)", () => {
  // A response like "I don't disagree with X" contains "disagree with" as a
  // substring and previously satisfied Layer 2 via includes(). The gate must
  // treat a disagreement signal preceded by negation as NOT a disagreement.
  for (const text of [
    "I don't disagree with the prior speaker about the migration timeline, and overall I think the plan looks fine.",
    "I do not disagree with the CTO's framing here, and we should proceed exactly as currently proposed today.",
    "I no longer disagree with the proposal now that the observability concern has been fully addressed by everyone.",
  ]) {
    it(`flags negated pseudo-disagreement: "${text.slice(0, 32)}…"`, () => {
      const result = applyQualityGate(text, { priorSpeakers: ["cto"] });
      expect(result.ok).toBe(false);
      expect(result.failures.some((f) => f.kind === "no_disagreement_signal")).toBe(true);
    });
  }

  it("still accepts genuine disagreement adjacent to a negated clause", () => {
    const text =
      "I disagree with the rollback plan because it omits database state and will corrupt downstream reads.";
    const result = applyQualityGate(text, { priorSpeakers: ["cto"] });
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

// ── Issue #49 ────────────────────────────────────────────────────────────────

/**
 * Table-driven coverage of every entry in DISAGREEMENT_SIGNALS.
 * Each fixture uses the named signal in a natural sentence (≥ 12 words,
 * no DEFAULT_FORBIDDEN_PHRASES). The sentences are crafted so that
 * removing the named signal from the source list causes exactly this row
 * to fail (i.e., each sentence is discriminating for its signal).
 */
const ALL_SIGNAL_FIXTURES: readonly (readonly [signal: string, text: string])[] = [
  [
    "i disagree",
    "I disagree, the latency budget ignores p99 tail spikes that occur during cache misses.",
  ],
  [
    "disagree with",
    "My colleagues disagree with the proposed rollout because the system lacks adequate monitoring coverage.",
  ],
  [
    "weak claim",
    "The weak claim in the prior analysis is that cache invalidation will handle itself cleanly.",
  ],
  [
    "weakness in",
    "There is a critical weakness in the design since it lacks circuit breakers for downstream calls.",
  ],
  [
    "counter",
    "Counter to what was proposed, the load tests reveal a forty percent failure rate in production.",
  ],
  [
    "omitted",
    "The prior speaker omitted the crucial detail about cross-region replication latency from the analysis.",
  ],
  [
    "missing from",
    "A critical risk missing from the plan is the schema migration rollback procedure and timeline.",
  ],
  [
    "did not address",
    "The proposal did not address how the system handles partial failures during the database migration.",
  ],
  [
    "did not consider",
    "The prior expert did not consider the on-call burden during the extended migration window period.",
  ],
  [
    "does not address",
    "The current plan does not address the risk of a network partition during live migration.",
  ],
  [
    "scenario where",
    "Here is a scenario where the proposal breaks: the primary database becomes unavailable mid-migration.",
  ],
  [
    "fails when",
    "The migration script fails when the target schema has undocumented foreign key constraints present.",
  ],
  [
    "would fail",
    "The proposed rollback strategy would fail if applied without first snapshotting the production database.",
  ],
  [
    "stress-tested",
    "I have stress-tested the migration approach and cannot find any material weakness worth flagging.",
  ],
] as const;

describe("applyQualityGate — all DISAGREEMENT_SIGNALS, table-driven (Layer 2, issue #49)", () => {
  it.each(ALL_SIGNAL_FIXTURES)('signal "%s" satisfies the disagreement budget', (_signal, text) => {
    const result = applyQualityGate(text, { priorSpeakers: ["cto"] });
    expect(result.failures.some((f) => f.kind === "no_disagreement_signal")).toBe(false);
  });
});

describe("applyQualityGate — negative near-miss cases (Layer 2, issue #49)", () => {
  it('"would not fail" does not satisfy the disagreement budget', () => {
    // The substring "would fail" is NOT present in "would not fail"; this
    // response must be rejected even though it contains cognate words.
    const text =
      "The database connection would not fail under normal load even during peak traffic hours.";
    const result = applyQualityGate(text, { priorSpeakers: ["cto"] });
    expect(result.failures.some((f) => f.kind === "no_disagreement_signal")).toBe(true);
  });

  it("a response that only affirms without any signal phrase is rejected", () => {
    // No signal substring is present; confirms the negative path of the budget check.
    const text =
      "The timeline looks reasonable to me and fits well with the team's current sprint capacity.";
    const result = applyQualityGate(text, { priorSpeakers: ["cto"] });
    expect(result.failures.some((f) => f.kind === "no_disagreement_signal")).toBe(true);
  });
});

// ── Issue #50 ────────────────────────────────────────────────────────────────

describe("applyQualityGate — MIN_WORDS boundary (Layer 3, issue #50)", () => {
  // MIN_WORDS = 12, per the constant in quality-gate.ts.
  // These sentences contain no forbidden phrases and no disagreement signals
  // so word-count is the only variable under test.
  //   11 words: "The proposal looks feasible given the current team size and capacity."
  //   12 words: …+ "here"
  //   13 words: …+ "our"
  const words11 = "The proposal looks feasible given the current team size and capacity.";
  const words12 = "The proposal looks feasible given the current team size and capacity here.";
  const words13 = "The proposal looks feasible given the current team size and our capacity here.";

  it("rejects a response with MIN_WORDS-1 (11 words) as too_short", () => {
    const result = applyQualityGate(words11, { priorSpeakers: [] });
    expect(result.failures.some((f) => f.kind === "too_short")).toBe(true);
  });

  it("accepts a response with exactly MIN_WORDS (12 words) as not too_short", () => {
    const result = applyQualityGate(words12, { priorSpeakers: [] });
    expect(result.failures.some((f) => f.kind === "too_short")).toBe(false);
  });

  it("accepts a response with MIN_WORDS+1 (13 words) as not too_short", () => {
    const result = applyQualityGate(words13, { priorSpeakers: [] });
    expect(result.failures.some((f) => f.kind === "too_short")).toBe(false);
  });
});

// ── Issue #51 ────────────────────────────────────────────────────────────────

describe("applyQualityGate — skip Layer 2 when too_short (UX design choice, issue #51)", () => {
  // When the response is below MIN_WORDS, the gate returns a single
  // too_short failure and does NOT add no_disagreement_signal — providing
  // focused, actionable feedback to the model.

  it("omits no_disagreement_signal when response is too_short with prior speakers (has signal)", () => {
    // "I disagree." has a signal but is under 12 words; only too_short surfaces.
    const result = applyQualityGate("I disagree.", { priorSpeakers: ["cto", "pm"] });
    expect(result.failures.some((f) => f.kind === "too_short")).toBe(true);
    expect(result.failures.some((f) => f.kind === "no_disagreement_signal")).toBe(false);
  });

  it("omits no_disagreement_signal when response is too_short with prior speakers (no signal)", () => {
    // No signal and under 12 words: only too_short surfaces, not both failures.
    const result = applyQualityGate("Agreed.", { priorSpeakers: ["cto"] });
    expect(result.failures.some((f) => f.kind === "too_short")).toBe(true);
    expect(result.failures.some((f) => f.kind === "no_disagreement_signal")).toBe(false);
  });

  it("does add no_disagreement_signal when response meets MIN_WORDS but lacks a signal", () => {
    // Confirms the skip only applies when too_short; at or above MIN_WORDS
    // the disagreement check re-engages.
    const text = "The proposal looks feasible given the current team size and capacity here."; // 12 words
    const result = applyQualityGate(text, { priorSpeakers: ["cto"] });
    expect(result.failures.some((f) => f.kind === "too_short")).toBe(false);
    expect(result.failures.some((f) => f.kind === "no_disagreement_signal")).toBe(true);
  });
});
