/**
 * Tests for the four official GO-TO-MARKET built-in Council panels (T-library-6):
 *   - brand-positioning-review
 *   - pricing-packaging-review
 *   - enterprise-deal-review
 *   - negotiation-prep
 *
 * Every panel must:
 *   - live as `packages/cli/panels/<name>.yaml`, be discoverable by the
 *     directory scan, and validate against {@link PanelDefinitionSchema}
 *   - have a `name` equal to its kebab-case filename slug
 *   - field 4-5 inline experts, each with a DISTINCT role (so the perspectives
 *     genuinely disagree instead of collapsing) and a non-empty expertise prior
 *     (>= 4 weightedEvidence, >= 2 referenceCases, >= 2 notExpertIn) plus a
 *     first-person, scarred `epistemicStance`
 *   - ship >= 2 `samplePrompts`, a `decisionArtifact`, and discovery `tags`
 *   - pass `lintPanelDefinition(panel, { official: true })` with ZERO errors —
 *     the strict official bar every v1 panel must clear (no generic filler, real
 *     evidence priors, distinct role archetypes, sample prompts present)
 *
 * RED at the `test(panels)` commit: the four `panels/*.yaml` files do not exist
 * yet, so `loadTemplateFromFile` / `readRawPanel` reject and `listTemplates`
 * omits them.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import * as yaml from "yaml";

import type { ExpertDefinition } from "../../../src/core/expert.js";
import { lintPanelDefinition } from "../../../src/core/panel-lint.js";
import {
  listTemplates,
  loadTemplateFromFile,
  PanelDefinitionSchema,
  type PanelDefinition,
} from "../../../src/core/template-loader.js";

const PANELS_DIR = path.resolve(import.meta.dirname, "../../../panels");

const GTM_PANELS = [
  "brand-positioning-review",
  "pricing-packaging-review",
  "enterprise-deal-review",
  "negotiation-prep",
] as const;

// The official quality-gate minimums enforced by `core/panel-lint.ts`.
const MIN_EXPERTS = 4;
const MAX_EXPERTS = 5;
const MIN_WEIGHTED_EVIDENCE = 4;
const MIN_REFERENCE_CASES = 2;
const MIN_NOT_EXPERT_IN = 2;
const MIN_SAMPLE_PROMPTS = 2;

function panelPath(name: string): string {
  return path.join(PANELS_DIR, `${name}.yaml`);
}

async function readRawPanel(name: string): Promise<unknown> {
  const raw = await fs.readFile(panelPath(name), "utf-8");
  return yaml.parse(raw);
}

function inlineExperts(panel: PanelDefinition): ExpertDefinition[] {
  return panel.experts.filter((e): e is ExpertDefinition => typeof e !== "string");
}

describe("official GTM panels — directory scan", () => {
  it("exposes all four panels as built-in templates", async () => {
    const names = await listTemplates();
    for (const name of GTM_PANELS) {
      expect(names).toContain(name);
    }
  });
});

describe.each(GTM_PANELS)("official GTM panel: %s", (name) => {
  it("loads, validates, and its name matches the filename slug", async () => {
    const panel = await loadTemplateFromFile(panelPath(name));
    expect(panel.name).toBe(name);
    expect(PanelDefinitionSchema.safeParse(panel).success).toBe(true);
    expect((panel.description ?? "").trim().length).toBeGreaterThan(10);
  });

  it("uses freeform mode, 4 rounds, and the claude-sonnet-4.5 default model", async () => {
    const panel = await loadTemplateFromFile(panelPath(name));
    expect(panel.defaults?.mode).toBe("freeform");
    expect(panel.defaults?.maxRounds).toBe(4);
    expect(panel.defaults?.model).toBe("claude-sonnet-4.5");
  });

  it("fields 4-5 inline experts with distinct slugs and distinct roles", async () => {
    const panel = await loadTemplateFromFile(panelPath(name));
    expect(panel.experts.length).toBeGreaterThanOrEqual(MIN_EXPERTS);
    expect(panel.experts.length).toBeLessThanOrEqual(MAX_EXPERTS);

    const inline = inlineExperts(panel);
    // Built-in panels must be fully self-contained (no slug references).
    expect(inline).toHaveLength(panel.experts.length);

    const slugs = inline.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);

    // Distinct role archetypes => the experts genuinely disagree.
    const roles = inline.map((e) => e.role.trim().toLowerCase().replace(/\s+/g, " "));
    expect(new Set(roles).size).toBe(roles.length);
  });

  it("gives every expert a real expertise prior and a non-empty scarred stance", async () => {
    const panel = await loadTemplateFromFile(panelPath(name));
    const inline = inlineExperts(panel);
    expect(inline.length).toBe(panel.experts.length);

    for (const expert of inline) {
      expect(expert.expertise.weightedEvidence.length).toBeGreaterThanOrEqual(
        MIN_WEIGHTED_EVIDENCE,
      );
      expect(expert.expertise.referenceCases.length).toBeGreaterThanOrEqual(MIN_REFERENCE_CASES);
      expect(expert.expertise.notExpertIn.length).toBeGreaterThanOrEqual(MIN_NOT_EXPERT_IN);
      expect(expert.epistemicStance.trim().length).toBeGreaterThan(0);
      expect(expert.displayName.trim().length).toBeGreaterThan(0);

      for (const item of [
        ...expert.expertise.weightedEvidence,
        ...expert.expertise.referenceCases,
        ...expert.expertise.notExpertIn,
      ]) {
        expect(item.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("ships >= 2 sample prompts, a decision artifact, and discovery tags", async () => {
    const panel = await loadTemplateFromFile(panelPath(name));
    expect(panel.samplePrompts?.length ?? 0).toBeGreaterThanOrEqual(MIN_SAMPLE_PROMPTS);
    expect((panel.decisionArtifact ?? "").trim().length).toBeGreaterThan(0);
    expect(panel.tags?.length ?? 0).toBeGreaterThan(0);
  });

  it("passes the panel quality gate at the OFFICIAL bar with zero errors", async () => {
    const raw = await readRawPanel(name);
    const result = lintPanelDefinition(raw, { official: true });
    // Surface the offending findings in the failure message for fast triage.
    expect(result.errorCount, JSON.stringify(result.findings, null, 2)).toBe(0);
    expect(result.ok).toBe(true);
  });
});
