/**
 * Tests for the pure panel quality-gate linter (`src/core/panel-lint.ts`).
 *
 * `lintPanelDefinition(panel, options?)` accepts an UNVALIDATED object (so it
 * can report schema errors itself) and returns a {@link LintResult} with
 * rule-tagged findings at either `error` or `warning` severity.
 *
 * Severity design (so the 5 existing un-normalized built-ins are NOT
 * hard-failures yet — they ship without `samplePrompts` and a couple use the
 * word "leverage"):
 *   - Structural defects (too few weightedEvidence / referenceCases /
 *     notExpertIn, duplicate roles, schema errors, regulated-domain framing)
 *     are ALWAYS `error`.
 *   - Quality/style defects (missing samplePrompts, generic filler phrases,
 *     slug references, expert-count outside 3-5) are `warning` by default and
 *     escalate to `error` only under `{ official: true }` — the strict bar the
 *     12 future v1 panels must pass.
 *
 * RED at this commit: `src/core/panel-lint.ts` does not yet exist.
 */
import { describe, expect, it } from "vitest";

import {
  BANNED_FILLER_PHRASES,
  lintPanelDefinition,
  type LintFinding,
  type LintResult,
} from "../../../src/core/panel-lint.js";
import { DEFAULT_FORBIDDEN_PHRASES } from "../../../src/core/prompt-builder.js";

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

interface ExpertOverrides {
  readonly slug?: string;
  readonly displayName?: string;
  readonly role?: string;
  readonly weightedEvidence?: readonly string[];
  readonly referenceCases?: readonly string[];
  readonly notExpertIn?: readonly string[];
  readonly epistemicStance?: string;
}

function validExpert(slug: string, overrides: ExpertOverrides = {}): Record<string, unknown> {
  return {
    slug: overrides.slug ?? slug,
    displayName: overrides.displayName ?? `Expert ${slug}`,
    role: overrides.role ?? `${slug} domain specialist`,
    expertise: {
      weightedEvidence: overrides.weightedEvidence ?? [
        "Latency budgets under peak production load",
        "Failure modes of queue backpressure",
        "Schema migration safety on live tables",
        "Idempotency of retried write operations",
      ],
      referenceCases: overrides.referenceCases ?? [
        "The cache stampede that took down checkout",
        "The migration that locked the orders table",
      ],
      notExpertIn: overrides.notExpertIn ?? ["frontend animation", "tax accounting"],
    },
    epistemicStance:
      overrides.epistemicStance ??
      "You trust measurement over intuition and prefer reversible decisions.",
    kind: "generic",
  };
}

/**
 * A synthetic panel that satisfies EVERY rule — it must lint clean (zero
 * findings) even under the strict official bar.
 */
function validPanel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "synthetic-panel",
    description: "A panel that pressure-tests product and platform decisions.",
    samplePrompts: ["Should we adopt event sourcing for the orders service?"],
    experts: [
      validExpert("backend", { role: "Backend systems engineer" }),
      validExpert("design", { role: "Product designer" }),
      validExpert("privacy", { role: "Data privacy specialist" }),
      validExpert("support", { role: "Customer support lead" }),
    ],
    ...overrides,
  };
}

function findingFor(result: LintResult, ruleId: string): LintFinding | undefined {
  return result.findings.find((f) => f.ruleId === ruleId);
}

function ruleIds(result: LintResult): string[] {
  return result.findings.map((f) => f.ruleId);
}

// ──────────────────────────────────────────────────────────────────────
// schema-valid
// ──────────────────────────────────────────────────────────────────────

describe("lintPanelDefinition — schema-valid", () => {
  it("flags a missing required field with an error and does not run deeper rules", () => {
    const { name: _omit, ...noName } = validPanel();
    const result = lintPanelDefinition(noName);
    expect(result.ok).toBe(false);
    const schema = findingFor(result, "schema-valid");
    expect(schema).toBeDefined();
    expect(schema?.severity).toBe("error");
    // Early return: only schema findings, no structural noise on an invalid shape.
    expect(new Set(ruleIds(result))).toEqual(new Set(["schema-valid"]));
  });

  it.each([null, undefined, "a string", 42, []])(
    "flags non-object / malformed input %p as a schema error",
    (bad) => {
      const result = lintPanelDefinition(bad);
      expect(result.ok).toBe(false);
      expect(findingFor(result, "schema-valid")?.severity).toBe("error");
    },
  );

  it("rejects an experts list larger than the schema maximum (8)", () => {
    const experts = Array.from({ length: 9 }, (_, i) =>
      validExpert(`e${i}`, { role: `role ${i}` }),
    );
    const result = lintPanelDefinition(validPanel({ experts }));
    expect(result.ok).toBe(false);
    expect(findingFor(result, "schema-valid")).toBeDefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Valid panel — clean under both modes
// ──────────────────────────────────────────────────────────────────────

describe("lintPanelDefinition — a fully valid panel", () => {
  it("produces zero findings in default mode", () => {
    const result = lintPanelDefinition(validPanel());
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  it("produces zero findings under the strict official bar", () => {
    const result = lintPanelDefinition(validPanel(), { official: true });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// sample-prompts (warning → error when official)
// ──────────────────────────────────────────────────────────────────────

describe("lintPanelDefinition — sample-prompts", () => {
  it("warns when samplePrompts is absent (default mode)", () => {
    const { samplePrompts: _drop, ...noPrompts } = validPanel();
    const result = lintPanelDefinition(noPrompts);
    const f = findingFor(result, "sample-prompts");
    expect(f?.severity).toBe("warning");
    expect(result.ok).toBe(true); // warnings never fail
  });

  it("warns when samplePrompts is an empty array", () => {
    const result = lintPanelDefinition(validPanel({ samplePrompts: [] }));
    expect(findingFor(result, "sample-prompts")?.severity).toBe("warning");
  });

  it("escalates the missing-samplePrompts warning to an error under official", () => {
    const { samplePrompts: _drop, ...noPrompts } = validPanel();
    const result = lintPanelDefinition(noPrompts, { official: true });
    expect(findingFor(result, "sample-prompts")?.severity).toBe("error");
    expect(result.ok).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// expert-count (always a warning — schema enforces the 1..8 hard bounds)
// ──────────────────────────────────────────────────────────────────────

describe("lintPanelDefinition — expert-count", () => {
  it("warns when there are fewer than 3 experts", () => {
    const result = lintPanelDefinition(
      validPanel({
        experts: [validExpert("a", { role: "role a" }), validExpert("b", { role: "role b" })],
      }),
    );
    expect(findingFor(result, "expert-count")?.severity).toBe("warning");
  });

  it("warns when there are more than 5 experts", () => {
    const experts = Array.from({ length: 6 }, (_, i) =>
      validExpert(`e${i}`, { role: `role ${i}` }),
    );
    const result = lintPanelDefinition(validPanel({ experts }));
    expect(findingFor(result, "expert-count")?.severity).toBe("warning");
  });

  it("does not warn for a 4-expert panel", () => {
    const result = lintPanelDefinition(validPanel());
    expect(findingFor(result, "expert-count")).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// per-expert structural minimums (always errors)
// ──────────────────────────────────────────────────────────────────────

describe("lintPanelDefinition — per-expert structural minimums", () => {
  it("errors when an expert has fewer than 4 weightedEvidence entries", () => {
    const result = lintPanelDefinition(
      validPanel({
        experts: [
          validExpert("a", { role: "role a", weightedEvidence: ["one", "two", "three"] }),
          validExpert("b", { role: "role b" }),
          validExpert("c", { role: "role c" }),
        ],
      }),
    );
    const f = findingFor(result, "expert-evidence");
    expect(f?.severity).toBe("error");
    expect(f?.message).toContain("a"); // names the offending expert slug
    expect(result.ok).toBe(false);
  });

  it("errors when an expert has fewer than 2 referenceCases", () => {
    const result = lintPanelDefinition(
      validPanel({
        experts: [
          validExpert("a", { role: "role a", referenceCases: ["only one"] }),
          validExpert("b", { role: "role b" }),
          validExpert("c", { role: "role c" }),
        ],
      }),
    );
    expect(findingFor(result, "expert-reference-cases")?.severity).toBe("error");
  });

  it("errors when an expert has fewer than 2 notExpertIn entries", () => {
    const result = lintPanelDefinition(
      validPanel({
        experts: [
          validExpert("a", { role: "role a", notExpertIn: ["only one"] }),
          validExpert("b", { role: "role b" }),
          validExpert("c", { role: "role c" }),
        ],
      }),
    );
    expect(findingFor(result, "expert-not-expert-in")?.severity).toBe("error");
  });
});

// ──────────────────────────────────────────────────────────────────────
// duplicate-role (always an error)
// ──────────────────────────────────────────────────────────────────────

describe("lintPanelDefinition — duplicate-role", () => {
  it("errors when two experts share a role archetype (whitespace/case-insensitive)", () => {
    const result = lintPanelDefinition(
      validPanel({
        experts: [
          validExpert("a", { role: "Security Auditor" }),
          validExpert("b", { role: "  security   auditor " }),
          validExpert("c", { role: "role c" }),
        ],
      }),
    );
    expect(findingFor(result, "duplicate-role")?.severity).toBe("error");
    expect(result.ok).toBe(false);
  });

  it("does not flag distinct roles", () => {
    const result = lintPanelDefinition(validPanel());
    expect(findingFor(result, "duplicate-role")).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// filler-phrase (warning → error when official)
// ──────────────────────────────────────────────────────────────────────

describe("lintPanelDefinition — filler-phrase", () => {
  it("includes both the prompt-builder defaults and the extra banned phrases", () => {
    for (const phrase of DEFAULT_FORBIDDEN_PHRASES) {
      expect(BANNED_FILLER_PHRASES).toContain(phrase);
    }
    for (const phrase of [
      "world-class",
      "seasoned expert",
      "best practices",
      "holistic",
      "synergy",
      "leverage",
      "robust",
      "thought leader",
    ]) {
      expect(BANNED_FILLER_PHRASES.some((p) => p.toLowerCase() === phrase)).toBe(true);
    }
  });

  it("warns (default) when an expert field contains a banned filler phrase", () => {
    const result = lintPanelDefinition(
      validPanel({
        experts: [
          validExpert("a", { role: "World-class strategist" }),
          validExpert("b", { role: "role b" }),
          validExpert("c", { role: "role c" }),
        ],
      }),
    );
    const f = findingFor(result, "filler-phrase");
    expect(f?.severity).toBe("warning");
    expect(f?.message.toLowerCase()).toContain("world-class");
  });

  it("catches a default prompt-builder phrase such as 'synergy'", () => {
    const result = lintPanelDefinition(
      validPanel({
        experts: [
          validExpert("a", { epistemicStance: "You believe in synergy above all." }),
          validExpert("b", { role: "role b" }),
          validExpert("c", { role: "role c" }),
        ],
      }),
    );
    expect(findingFor(result, "filler-phrase")).toBeDefined();
  });

  it("escalates filler phrases to errors under official", () => {
    const result = lintPanelDefinition(
      validPanel({
        experts: [
          validExpert("a", { role: "Seasoned expert in growth" }),
          validExpert("b", { role: "role b" }),
          validExpert("c", { role: "role c" }),
        ],
      }),
      { official: true },
    );
    expect(findingFor(result, "filler-phrase")?.severity).toBe("error");
    expect(result.ok).toBe(false);
  });

  it("matches on word boundaries, not arbitrary substrings", () => {
    // "leverages" / "robustness" should NOT trip the "leverage" / "robust" rules.
    const result = lintPanelDefinition(
      validPanel({
        experts: [
          validExpert("a", {
            role: "Reliability engineer",
            epistemicStance: "You value robustness and the leverages of automation.",
          }),
          validExpert("b", { role: "role b" }),
          validExpert("c", { role: "role c" }),
        ],
      }),
      { official: true },
    );
    expect(findingFor(result, "filler-phrase")).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// expert-slug-reference (warning → error when official)
// ──────────────────────────────────────────────────────────────────────

describe("lintPanelDefinition — expert-slug-reference", () => {
  it("warns when an expert entry is a slug string (cannot be deep-linted)", () => {
    const result = lintPanelDefinition(
      validPanel({
        experts: [
          "some-slug",
          validExpert("b", { role: "role b" }),
          validExpert("c", { role: "role c" }),
        ],
      }),
    );
    expect(findingFor(result, "expert-slug-reference")?.severity).toBe("warning");
    // warnings only: a slug ref alone must not fail the default gate
    expect(result.ok).toBe(true);
  });

  it("escalates slug references to errors under official (built-ins must be inline)", () => {
    const result = lintPanelDefinition(
      validPanel({
        experts: [
          "some-slug",
          validExpert("b", { role: "role b" }),
          validExpert("c", { role: "role c" }),
        ],
      }),
      { official: true },
    );
    expect(findingFor(result, "expert-slug-reference")?.severity).toBe("error");
    expect(result.ok).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// regulated-domain-framing (always an error when triggered)
// ──────────────────────────────────────────────────────────────────────

describe("lintPanelDefinition — regulated-domain-framing", () => {
  it("errors when regulatedDomain is set but no non-advice framing is present", () => {
    const result = lintPanelDefinition(validPanel({ regulatedDomain: "finance" }));
    expect(findingFor(result, "regulated-domain-framing")?.severity).toBe("error");
    expect(result.ok).toBe(false);
  });

  it("passes when explicit non-advice framing is present in the description", () => {
    const result = lintPanelDefinition(
      validPanel({
        regulatedDomain: "legal",
        description:
          "A panel offering decision-support only — this is not legal advice and is for informational purposes.",
      }),
    );
    expect(findingFor(result, "regulated-domain-framing")).toBeUndefined();
  });

  it("does nothing when regulatedDomain is absent", () => {
    const result = lintPanelDefinition(validPanel());
    expect(findingFor(result, "regulated-domain-framing")).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// result accounting
// ──────────────────────────────────────────────────────────────────────

describe("lintPanelDefinition — result accounting", () => {
  it("computes ok/errorCount/warningCount consistently", () => {
    const { samplePrompts: _drop, ...noPrompts } = validPanel();
    const result = lintPanelDefinition({
      ...noPrompts,
      experts: [
        validExpert("a", { role: "role a", referenceCases: ["one"] }), // error
        validExpert("b", { role: "World-class b" }), // warning (filler)
        validExpert("c", { role: "role c" }),
      ],
    });
    expect(result.errorCount).toBeGreaterThanOrEqual(1);
    expect(result.warningCount).toBeGreaterThanOrEqual(1);
    expect(result.ok).toBe(result.errorCount === 0);
    expect(result.findings.length).toBe(result.errorCount + result.warningCount);
  });
});
