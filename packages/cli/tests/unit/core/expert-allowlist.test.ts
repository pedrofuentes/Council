/**
 * 🔴 SENT-1062 #3 (Dim A2): `panel save` must promote an EXPLICIT, allowlisted
 * expert object into the library instead of spreading the whole stored expert
 * (`{ ...expert, slug }`). The allowlist drops any unexpected runtime property
 * while preserving every field the round-trip / resolve path needs, and
 * applies an optional slug override.
 *
 * RED at this commit: `allowlistExpertDefinition` is not exported yet.
 */
import { describe, expect, it } from "vitest";

import { allowlistExpertDefinition, type ExpertDefinition } from "../../../src/core/expert.js";

function baseExpert(): ExpertDefinition {
  return {
    slug: "alpha",
    displayName: "Alpha (Skeptic)",
    role: "Skeptic",
    model: "test-model",
    expertise: {
      weightedEvidence: ["counter-examples"],
      referenceCases: [],
      notExpertIn: [],
    },
    epistemicStance: "Alpha rejects claims without falsification tests.",
    kind: "generic",
  };
}

describe("allowlistExpertDefinition (T9 SENT-1062 #3)", () => {
  it("drops unexpected fields and applies the slug override", () => {
    const tainted = {
      ...baseExpert(),
      maliciousField: "INJECTED",
      __proto__hack: "INJECTED",
    } as unknown as ExpertDefinition;

    const result = allowlistExpertDefinition(tainted, "alpha-2");

    expect(Object.keys(result)).not.toContain("maliciousField");
    expect(Object.keys(result)).not.toContain("__proto__hack");
    // Slug override applied; round-trip-critical fields preserved verbatim.
    expect(result.slug).toBe("alpha-2");
    expect(result.displayName).toBe("Alpha (Skeptic)");
    expect(result.role).toBe("Skeptic");
    expect(result.model).toBe("test-model");
    expect(result.epistemicStance).toBe("Alpha rejects claims without falsification tests.");
    expect(result.kind).toBe("generic");
    expect(result.expertise.weightedEvidence).toEqual(["counter-examples"]);
  });

  it("keeps the original slug when no override is given", () => {
    const result = allowlistExpertDefinition(baseExpert());
    expect(result.slug).toBe("alpha");
  });

  it("preserves persona-only fields needed for round-trip integrity", () => {
    const persona: ExpertDefinition = {
      ...baseExpert(),
      kind: "persona",
      personaDescription: "VP of Engineering I report to",
      docsPath: "/docs/vp",
      debateProtocol: "custom protocol",
      outputContract: "custom contract",
      forbiddenMoves: ["strawman"],
      personality: "measured",
    };

    const result = allowlistExpertDefinition(persona);

    expect(result.kind).toBe("persona");
    expect(result.personaDescription).toBe("VP of Engineering I report to");
    expect(result.docsPath).toBe("/docs/vp");
    expect(result.debateProtocol).toBe("custom protocol");
    expect(result.outputContract).toBe("custom contract");
    expect(result.forbiddenMoves).toEqual(["strawman"]);
    expect(result.personality).toBe("measured");
  });
});
