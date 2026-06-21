/**
 * Tests for the four official business panels (T-library-7):
 *
 *   - fpna-budget-review              (regulatedDomain: finance)
 *   - hiring-decision-review          (regulatedDomain: hr)
 *   - legal-risk-review               (regulatedDomain: legal)
 *   - executive-strategy-board-prep   (NOT regulated)
 *
 * Each panel must:
 *   - parse against PanelDefinitionSchema and load as a self-contained built-in
 *   - carry 4-5 inline experts with full expertise priors + a scarred stance
 *   - ship >= 2 sample prompts and a decision artifact
 *   - declare the correct regulatedDomain (or none)
 *   - pass the OFFICIAL-bar quality gate (`lintPanelDefinition(panel, { official: true })`)
 *     with ZERO errors — which, for the three regulated panels, requires the
 *     explicit non-advice / decision-support framing.
 *
 * RED at the `test(panels)` commit: the four `panels/*.yaml` files do not yet
 * exist, so `loadTemplateFromFile` rejects with ENOENT.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ExpertDefinition } from "../../../src/core/expert.js";
import { lintPanelDefinition } from "../../../src/core/panel-lint.js";
import {
  loadTemplate,
  loadTemplateFromFile,
  type PanelDefinition,
  type RegulatedDomain,
} from "../../../src/core/template-loader.js";

const PANELS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../panels");

const MIN_EXPERTS = 4;
const MAX_EXPERTS = 5;
// Mirror the official-bar thresholds enforced by core/panel-lint.ts so the
// structural assertions here track the real quality gate.
const MIN_WEIGHTED_EVIDENCE = 4;
const MIN_REFERENCE_CASES = 2;
const MIN_NOT_EXPERT_IN = 2;
const MIN_SAMPLE_PROMPTS = 2;

interface PanelExpectation {
  readonly name: string;
  /** The regulated advice domain, or null for the non-regulated panel. */
  readonly regulatedDomain: RegulatedDomain | null;
}

const PANELS: readonly PanelExpectation[] = [
  { name: "fpna-budget-review", regulatedDomain: "finance" },
  { name: "hiring-decision-review", regulatedDomain: "hr" },
  { name: "legal-risk-review", regulatedDomain: "legal" },
  { name: "executive-strategy-board-prep", regulatedDomain: null },
];

function loadPanelFile(name: string): Promise<PanelDefinition> {
  return loadTemplateFromFile(path.join(PANELS_DIR, `${name}.yaml`));
}

function inlineExperts(panel: PanelDefinition): readonly ExpertDefinition[] {
  return panel.experts.filter((e): e is ExpertDefinition => typeof e !== "string");
}

describe("official business panels (FINANCE / PEOPLE / LEGAL / EXEC)", () => {
  for (const expectation of PANELS) {
    describe(expectation.name, () => {
      it("loads and parses against PanelDefinitionSchema", async () => {
        const panel = await loadPanelFile(expectation.name);
        expect(panel.name).toBe(expectation.name);
        expect(panel.description).toBeDefined();
        expect((panel.description ?? "").length).toBeGreaterThan(20);
        expect(panel.defaults?.mode).toBe("freeform");
        expect(panel.defaults?.maxRounds).toBe(4);
        expect(panel.defaults?.model).toBe("claude-sonnet-4.5");
      });

      it("is discoverable as a self-contained built-in (all experts inline)", async () => {
        // loadTemplate() throws if any expert is a slug reference, so a clean
        // load proves the panel is fully inline and built-in-resolvable.
        const resolved = await loadTemplate(expectation.name);
        expect(resolved.name).toBe(expectation.name);
        expect(resolved.experts.length).toBeGreaterThanOrEqual(MIN_EXPERTS);
        expect(resolved.experts.length).toBeLessThanOrEqual(MAX_EXPERTS);
      });

      it("carries 4-5 experts with full expertise priors and a scarred stance", async () => {
        const panel = await loadPanelFile(expectation.name);
        const experts = inlineExperts(panel);
        expect(experts.length).toBe(panel.experts.length); // none are slug refs
        expect(experts.length).toBeGreaterThanOrEqual(MIN_EXPERTS);
        expect(experts.length).toBeLessThanOrEqual(MAX_EXPERTS);

        for (const expert of experts) {
          expect(expert.slug.length).toBeGreaterThan(0);
          expect(expert.displayName.length).toBeGreaterThan(0);
          expect(expert.role.length).toBeGreaterThan(0);
          expect(expert.expertise.weightedEvidence.length).toBeGreaterThanOrEqual(
            MIN_WEIGHTED_EVIDENCE,
          );
          expect(expert.expertise.referenceCases.length).toBeGreaterThanOrEqual(
            MIN_REFERENCE_CASES,
          );
          expect(expert.expertise.notExpertIn.length).toBeGreaterThanOrEqual(MIN_NOT_EXPERT_IN);
          // A scarred, first-person stance is substantive, not a one-liner.
          expect(expert.epistemicStance.length).toBeGreaterThan(40);
        }
      });

      it("gives every expert a distinct slug and role archetype", async () => {
        const experts = inlineExperts(await loadPanelFile(expectation.name));
        const slugs = experts.map((e) => e.slug);
        expect(new Set(slugs).size).toBe(slugs.length);
        const roles = experts.map((e) => e.role.trim().toLowerCase().replace(/\s+/g, " "));
        expect(new Set(roles).size).toBe(roles.length);
      });

      it("ships >= 2 sample prompts and a decision artifact", async () => {
        const panel = await loadPanelFile(expectation.name);
        expect(panel.samplePrompts?.length ?? 0).toBeGreaterThanOrEqual(MIN_SAMPLE_PROMPTS);
        expect(panel.decisionArtifact).toBeDefined();
        expect((panel.decisionArtifact ?? "").length).toBeGreaterThan(0);
        expect(panel.tags?.length ?? 0).toBeGreaterThan(0);
      });

      it(`declares regulatedDomain = ${expectation.regulatedDomain ?? "none"}`, async () => {
        const panel = await loadPanelFile(expectation.name);
        if (expectation.regulatedDomain === null) {
          expect(panel.regulatedDomain).toBeUndefined();
        } else {
          expect(panel.regulatedDomain).toBe(expectation.regulatedDomain);
        }
      });

      it("passes the OFFICIAL-bar quality gate with zero errors", async () => {
        const panel = await loadPanelFile(expectation.name);
        const result = lintPanelDefinition(panel, { official: true });
        // Surface any findings in the failure message for fast diagnosis.
        expect(result.errorCount, JSON.stringify(result.findings, null, 2)).toBe(0);
        expect(result.ok).toBe(true);
        expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
      });
    });
  }

  it("the three regulated panels satisfy the non-advice framing rule", async () => {
    const regulated = PANELS.filter((p) => p.regulatedDomain !== null);
    expect(regulated).toHaveLength(3);
    for (const expectation of regulated) {
      const panel = await loadPanelFile(expectation.name);
      expect(panel.regulatedDomain).toBe(expectation.regulatedDomain);
      const result = lintPanelDefinition(panel, { official: true });
      const framingFinding = result.findings.find((f) => f.ruleId === "regulated-domain-framing");
      expect(
        framingFinding,
        `${expectation.name} is missing non-advice / decision-support framing`,
      ).toBeUndefined();
    }
  });
});
