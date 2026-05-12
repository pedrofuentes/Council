/**
 * Tests for the Expert system.
 *
 * Covers:
 *   - ExpertDefinition schema validates required fields and ranges
 *   - buildSystemPrompt() produces all 8 sections in correct order
 *   - Default forbidden phrases are always included even if profile customizes them
 *   - Default debate protocol is used when profile doesn't override
 *   - Memory section is empty when no memory provided
 *   - Memory section formats as terse bulleted log when provided
 *   - Current task section is injected per-turn
 *
 * RED at this commit: src/core/expert.ts and src/core/prompt-builder.ts do
 * not yet exist.
 */
import { describe, expect, it } from "vitest";

import { ExpertDefinitionSchema, type ExpertDefinition } from "../../../src/core/expert.js";
import {
  buildSystemPrompt,
  DEFAULT_FORBIDDEN_PHRASES,
  type ExpertMemory,
} from "../../../src/core/prompt-builder.js";

const baseDefinition: ExpertDefinition = {
  slug: "cto",
  displayName: "Dahlia Renner (CTO)",
  role: "Skeptical CTO with 20 years of production systems experience",
  expertise: {
    weightedEvidence: [
      "Production incident post-mortems",
      "Operational metrics (p99 latency, error budgets, on-call load)",
    ],
    referenceCases: [
      "Premature microservices: teams under 30 engineers re-consolidate within 18 months",
    ],
    notExpertIn: ["frontend UX", "ML", "GTM"],
  },
  epistemicStance:
    "You have been burned by elegant architectures the team couldn't operate. You'd ship a boring monolith over a beautiful mesh.",
};

describe("ExpertDefinitionSchema", () => {
  it("accepts a minimal valid definition", () => {
    const parsed = ExpertDefinitionSchema.parse(baseDefinition);
    expect(parsed.slug).toBe("cto");
  });

  it("rejects empty slug", () => {
    expect(() => ExpertDefinitionSchema.parse({ ...baseDefinition, slug: "" })).toThrow();
  });

  it("rejects empty displayName", () => {
    expect(() => ExpertDefinitionSchema.parse({ ...baseDefinition, displayName: "" })).toThrow();
  });

  it("rejects empty role", () => {
    expect(() => ExpertDefinitionSchema.parse({ ...baseDefinition, role: "" })).toThrow();
  });

  it("requires at least one weightedEvidence entry", () => {
    expect(() =>
      ExpertDefinitionSchema.parse({
        ...baseDefinition,
        expertise: { ...baseDefinition.expertise, weightedEvidence: [] },
      }),
    ).toThrow();
  });

  it("accepts optional model override", () => {
    const parsed = ExpertDefinitionSchema.parse({
      ...baseDefinition,
      model: "claude-opus-4",
    });
    expect(parsed.model).toBe("claude-opus-4");
  });

  it("defaults kind to 'generic' when omitted (back-compat)", () => {
    const parsed = ExpertDefinitionSchema.parse(baseDefinition);
    expect(parsed.kind).toBe("generic");
  });

  it("accepts kind: 'generic'", () => {
    const parsed = ExpertDefinitionSchema.parse({ ...baseDefinition, kind: "generic" });
    expect(parsed.kind).toBe("generic");
  });

  it("accepts kind: 'persona' with personaDescription and docsPath", () => {
    const parsed = ExpertDefinitionSchema.parse({
      ...baseDefinition,
      kind: "persona",
      personaDescription: "VP of Engineering I report to",
      docsPath: "~/Council/experts/sarah-vp/docs",
    });
    expect(parsed.kind).toBe("persona");
    expect(parsed.personaDescription).toBe("VP of Engineering I report to");
    expect(parsed.docsPath).toBe("~/Council/experts/sarah-vp/docs");
  });

  it("rejects unknown kind value", () => {
    expect(() => ExpertDefinitionSchema.parse({ ...baseDefinition, kind: "other" })).toThrow();
  });

  it("rejects empty personaDescription", () => {
    expect(() =>
      ExpertDefinitionSchema.parse({ ...baseDefinition, personaDescription: "" }),
    ).toThrow();
  });

  it("rejects empty docsPath", () => {
    expect(() => ExpertDefinitionSchema.parse({ ...baseDefinition, docsPath: "" })).toThrow();
  });

  it("accepts optional personality, debateProtocol, outputContract, forbiddenMoves", () => {
    const parsed = ExpertDefinitionSchema.parse({
      ...baseDefinition,
      personality: "Terse, sardonic.",
      debateProtocol: "Custom protocol text.",
      outputContract: "Custom output structure.",
      forbiddenMoves: ["never use weasel words"],
    });
    expect(parsed.personality).toBe("Terse, sardonic.");
    expect(parsed.forbiddenMoves).toEqual(["never use weasel words"]);
  });
});

describe("buildSystemPrompt() — section structure", () => {
  it("contains all 8 sections in order", () => {
    const prompt = buildSystemPrompt(baseDefinition, undefined, "Discuss microservices.");
    const sections = [
      "[1] IDENTITY",
      "[2] EXPERTISE PRIOR",
      "[3] EPISTEMIC STANCE",
      "[4] DEBATE PROTOCOL",
      "[5] OUTPUT CONTRACT",
      "[6] FORBIDDEN MOVES",
      "[7] MEMORY",
      "[8] CURRENT TASK",
    ];
    let lastIndex = -1;
    for (const heading of sections) {
      const idx = prompt.indexOf(heading);
      expect(idx, `Section "${heading}" should appear in prompt`).toBeGreaterThan(-1);
      expect(idx, `Section "${heading}" should come after previous`).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  it("IDENTITY section includes displayName and role", () => {
    const prompt = buildSystemPrompt(baseDefinition, undefined, "task");
    const identity = sectionContent(prompt, "[1] IDENTITY", "[2]");
    expect(identity).toContain(baseDefinition.displayName);
    expect(identity).toContain(baseDefinition.role);
  });

  it("EPISTEMIC STANCE section contains the profile's epistemicStance verbatim", () => {
    // Sentinel pr33 finding #2: the section-order test above only checks
    // the heading exists. This test pins that the actual stance text
    // (Layer 3 of anti-sycophancy: "identity stakes") is rendered into
    // section [3]. A regression that drops the stance line would otherwise
    // pass all tests.
    const prompt = buildSystemPrompt(baseDefinition, undefined, "task");
    const stance = sectionContent(prompt, "[3] EPISTEMIC STANCE", "[4]");
    expect(stance).toContain(baseDefinition.epistemicStance);
  });

  it("EXPERTISE PRIOR includes weighted evidence list and reference cases", () => {
    const prompt = buildSystemPrompt(baseDefinition, undefined, "task");
    const expertise = sectionContent(prompt, "[2] EXPERTISE PRIOR", "[3]");
    for (const evidence of baseDefinition.expertise.weightedEvidence) {
      expect(expertise).toContain(evidence);
    }
    for (const ref of baseDefinition.expertise.referenceCases) {
      expect(expertise).toContain(ref);
    }
  });

  it("EXPERTISE PRIOR mentions notExpertIn areas", () => {
    const prompt = buildSystemPrompt(baseDefinition, undefined, "task");
    const expertise = sectionContent(prompt, "[2] EXPERTISE PRIOR", "[3]");
    for (const area of baseDefinition.expertise.notExpertIn) {
      expect(expertise).toContain(area);
    }
  });

  it("CURRENT TASK section contains the per-turn task text verbatim", () => {
    const task = "Should we migrate from monolith to microservices?";
    const prompt = buildSystemPrompt(baseDefinition, undefined, task);
    const taskSection = sectionContent(prompt, "[8] CURRENT TASK", null);
    expect(taskSection).toContain(task);
  });
});

describe("buildSystemPrompt() — anti-sycophancy defaults", () => {
  it("FORBIDDEN MOVES section always includes default forbidden phrases", () => {
    const prompt = buildSystemPrompt(baseDefinition, undefined, "task");
    const forbidden = sectionContent(prompt, "[6] FORBIDDEN MOVES", "[7]");
    for (const phrase of DEFAULT_FORBIDDEN_PHRASES) {
      expect(forbidden).toContain(phrase);
    }
  });

  it("FORBIDDEN MOVES includes profile's custom forbiddenMoves AND defaults", () => {
    const customMove = "never use the word `synergy`";
    const definition: ExpertDefinition = {
      ...baseDefinition,
      forbiddenMoves: [customMove],
    };
    const prompt = buildSystemPrompt(definition, undefined, "task");
    const forbidden = sectionContent(prompt, "[6] FORBIDDEN MOVES", "[7]");
    expect(forbidden).toContain(customMove);
    // Defaults are still present:
    for (const phrase of DEFAULT_FORBIDDEN_PHRASES) {
      expect(forbidden).toContain(phrase);
    }
  });

  it("FORBIDDEN MOVES still includes defaults when profile sets forbiddenMoves: [] (cannot suppress anti-sycophancy)", () => {
    // Sentinel pr33 finding #1: an empty forbiddenMoves array must NOT be
    // treated as "I want to opt out of defaults". A regression in the merge
    // logic (e.g., `def.forbiddenMoves ?? DEFAULT_FORBIDDEN_PHRASES`) would
    // silently drop every default — this test catches that.
    const definition: ExpertDefinition = {
      ...baseDefinition,
      forbiddenMoves: [],
    };
    const prompt = buildSystemPrompt(definition, undefined, "task");
    const forbidden = sectionContent(prompt, "[6] FORBIDDEN MOVES", "[7]");
    for (const phrase of DEFAULT_FORBIDDEN_PHRASES) {
      expect(forbidden).toContain(phrase);
    }
  });

  it("DEBATE PROTOCOL falls back to default anti-sycophancy template when profile doesn't override", () => {
    const prompt = buildSystemPrompt(baseDefinition, undefined, "task");
    const protocol = sectionContent(prompt, "[4] DEBATE PROTOCOL", "[5]");
    // Default protocol mentions the disagreement budget concept
    expect(protocol.toLowerCase()).toMatch(/disagree|specific claim|counter/);
  });

  it("DEBATE PROTOCOL uses profile override when provided", () => {
    const customProtocol = "TEAM-SPECIFIC PROTOCOL: defer to PM on prioritization questions.";
    const definition: ExpertDefinition = {
      ...baseDefinition,
      debateProtocol: customProtocol,
    };
    const prompt = buildSystemPrompt(definition, undefined, "task");
    const protocol = sectionContent(prompt, "[4] DEBATE PROTOCOL", "[5]");
    expect(protocol).toContain(customProtocol);
  });
});

describe("buildSystemPrompt() — memory injection", () => {
  it("MEMORY section is empty (placeholder text only) when no memory provided", () => {
    const prompt = buildSystemPrompt(baseDefinition, undefined, "task");
    const memory = sectionContent(prompt, "[7] MEMORY", "[8]");
    // Placeholder so the model knows the section exists but has nothing yet
    expect(memory.toLowerCase()).toMatch(/no prior|first session|empty/);
  });

  it("MEMORY section formats positions/priors/unresolved as terse bulleted log", () => {
    const memory: ExpertMemory = {
      positions: ["Argued for monolith on 2026-04-01; team chose monolith."],
      updatedPriors: ["Previously over-weighted vendor lock-in; cost the team 3 months."],
      unresolved: ["Auth migration sequencing vs billing rewrite."],
    };
    const prompt = buildSystemPrompt(baseDefinition, memory, "task");
    const section = sectionContent(prompt, "[7] MEMORY", "[8]");
    expect(section).toContain("- Argued for monolith on 2026-04-01");
    expect(section).toContain("- Previously over-weighted vendor lock-in");
    expect(section).toContain("- Auth migration sequencing");
    // Sub-headings present so the model can categorize:
    expect(section.toLowerCase()).toContain("position");
    expect(section.toLowerCase()).toContain("prior");
    expect(section.toLowerCase()).toContain("unresolved");
  });

  it("omits memory sub-headings when their list is empty (terse log discipline)", () => {
    const memory: ExpertMemory = {
      positions: ["Only this one position."],
      updatedPriors: [],
      unresolved: [],
    };
    const prompt = buildSystemPrompt(baseDefinition, memory, "task");
    const section = sectionContent(prompt, "[7] MEMORY", "[8]");
    expect(section).toContain("- Only this one position.");
    // Empty sections should NOT clutter the prompt
    expect(section.toLowerCase()).not.toContain("updated prior");
    expect(section.toLowerCase()).not.toContain("unresolved");
  });
});

/**
 * Helper: extract the slice of `prompt` between the given startHeading and
 * the next heading marker (or end-of-string when nextHeading is null).
 */
function sectionContent(prompt: string, startHeading: string, nextHeading: string | null): string {
  const start = prompt.indexOf(startHeading);
  if (start < 0) throw new Error(`Section ${startHeading} not found`);
  const tail = prompt.slice(start);
  if (nextHeading === null) return tail;
  const nextIdx = tail.indexOf(nextHeading);
  return nextIdx < 0 ? tail : tail.slice(0, nextIdx);
}
