/**
 * 🔴 SENT-1062 convene-side blockers:
 *   #2 (Dim A2): convene must persist an EXPLICIT, allowlisted panel
 *       definition into `config_json.definition` instead of the raw resolved
 *       template object — dropping any unexpected runtime property while
 *       keeping every field the `panel save` round-trip needs.
 *   #1 (Dim A1): the post-debate `council panel save` hint must pass the
 *       (AI-derived) session name through stripControlChars before it reaches
 *       the terminal, matching the auto-compose banner convention.
 *
 * RED at this commit: `buildPersistedPanelDefinition` and
 * `formatPanelSaveHint` are not exported yet.
 */
import { describe, expect, it } from "vitest";

import {
  buildPersistedPanelDefinition,
  formatPanelSaveHint,
} from "../../../../src/cli/commands/convene.js";
import type { ResolvedPanelDefinition } from "../../../../src/core/template-loader.js";

function taintedTemplate(): ResolvedPanelDefinition {
  return {
    name: "auto-panel",
    description: "Auto-composed panel for the topic",
    experts: [
      {
        slug: "alpha",
        displayName: "Alpha (Skeptic)",
        role: "Skeptic",
        model: "test-model",
        expertise: { weightedEvidence: ["counter-examples"], referenceCases: [], notExpertIn: [] },
        epistemicStance: "Alpha rejects claims without falsification tests.",
        kind: "generic",
        evilExpertField: "INJECTED",
      },
    ],
    evilTopLevel: "INJECTED",
  } as unknown as ResolvedPanelDefinition;
}

describe("buildPersistedPanelDefinition (T9 SENT-1062 #2)", () => {
  it("persists only allowlisted definition + expert fields", () => {
    const persisted = buildPersistedPanelDefinition(taintedTemplate());

    // Top-level allowlist: no unexpected key leaks into config_json.
    expect(Object.keys(persisted)).not.toContain("evilTopLevel");
    expect(persisted.name).toBe("auto-panel");
    expect(persisted.description).toBe("Auto-composed panel for the topic");

    expect(persisted.experts).toHaveLength(1);
    const alpha = persisted.experts[0];
    expect(alpha).toBeDefined();
    expect(Object.keys(alpha ?? {})).not.toContain("evilExpertField");

    // Round-trip-critical fields preserved verbatim.
    expect(alpha?.slug).toBe("alpha");
    expect(alpha?.role).toBe("Skeptic");
    expect(alpha?.epistemicStance).toBe("Alpha rejects claims without falsification tests.");
    expect(alpha?.expertise.weightedEvidence).toEqual(["counter-examples"]);
  });
});

describe("formatPanelSaveHint (T9 SENT-1062 #1)", () => {
  it("strips control chars from the session name in the save hint", () => {
    const hint = formatPanelSaveHint("auto-panel\u001b[31m\u0007-2026-06-15T12:00:00");

    expect(hint).not.toContain("\u001b[");
    expect(hint).not.toContain("\u0007");
    expect(hint).toContain("council panel save");
    // Printable characters preserved.
    expect(hint).toContain("auto-panel");
  });
});
