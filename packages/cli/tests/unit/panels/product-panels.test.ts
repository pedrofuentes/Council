/**
 * Tests for the official PRODUCT / DESIGN / GROWTH built-in panels (T-library-5):
 *   - product-strategy-review
 *   - roadmap-prioritization
 *   - growth-experiment-review
 *   - ux-review
 *
 * These four panels must clear the OFFICIAL quality bar enforced by
 * `lintPanelDefinition(panel, { official: true })` — the same gate
 * `council panel lint --official` applies. For each panel we assert it:
 *   - is discovered by the template loader and parses against PanelDefinitionSchema,
 *   - declares 4-5 fully-specified inline experts (weightedEvidence /
 *     referenceCases / notExpertIn / epistemicStance all non-empty),
 *   - ships >= 2 samplePrompts, a decisionArtifact, and discovery tags,
 *   - lints clean (zero errors) at the official bar,
 *   - is NOT marked as a regulated domain (these are not legal/finance/hr panels).
 *
 * RED at this commit: none of the `panels/<name>.yaml` files exist yet, so the
 * loader cannot find them and `panelFile()` throws referencing the missing panel.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import * as yaml from "yaml";

import { lintPanelDefinition } from "../../../src/core/panel-lint.js";
import {
  listTemplateFiles,
  PanelDefinitionSchema,
  type PanelDefinition,
} from "../../../src/core/template-loader.js";

const PANEL_NAMES = [
  "product-strategy-review",
  "roadmap-prioritization",
  "growth-experiment-review",
  "ux-review",
] as const;

const MIN_EXPERTS = 4;
const MAX_EXPERTS = 5;
const MIN_SAMPLE_PROMPTS = 2;

/** Absolute path to the bundled panel YAML, discovered via the real loader. */
async function panelFile(name: string): Promise<string> {
  const files = await listTemplateFiles();
  const match = files.find((file) => path.basename(file) === `${name}.yaml`);
  if (match === undefined) {
    const available = files.map((file) => path.basename(file)).join(", ");
    throw new Error(`Built-in panel "${name}" not found among bundled panels: [${available}]`);
  }
  return match;
}

/** Raw, UNVALIDATED parsed YAML — exactly what `council panel lint` feeds the gate. */
async function readPanelObject(name: string): Promise<unknown> {
  const raw = await fs.readFile(await panelFile(name), "utf-8");
  return yaml.parse(raw);
}

for (const name of PANEL_NAMES) {
  describe(`official built-in panel: ${name}`, () => {
    it("parses against PanelDefinitionSchema", async () => {
      const result = PanelDefinitionSchema.safeParse(await readPanelObject(name));
      // Surface the actual schema issues if this ever regresses.
      expect(result.success ? [] : result.error.issues).toEqual([]);
      expect(result.success).toBe(true);
    });

    it("its name matches the filename slug", async () => {
      const parsed = PanelDefinitionSchema.parse(await readPanelObject(name));
      expect(parsed.name).toBe(name);
    });

    it("declares 4-5 fully-specified inline experts", async () => {
      const parsed: PanelDefinition = PanelDefinitionSchema.parse(await readPanelObject(name));
      expect(parsed.experts.length).toBeGreaterThanOrEqual(MIN_EXPERTS);
      expect(parsed.experts.length).toBeLessThanOrEqual(MAX_EXPERTS);

      for (const entry of parsed.experts) {
        // Official built-in panels must define experts inline, not by slug ref.
        expect(typeof entry).not.toBe("string");
        if (typeof entry === "string") continue; // narrow for the type-checker

        expect(entry.expertise.weightedEvidence.length).toBeGreaterThan(0);
        expect(entry.expertise.referenceCases.length).toBeGreaterThan(0);
        expect(entry.expertise.notExpertIn.length).toBeGreaterThan(0);
        expect(entry.epistemicStance.trim().length).toBeGreaterThan(0);
      }
    });

    it("ships >= 2 sample prompts, a decision artifact, and tags", async () => {
      const parsed = PanelDefinitionSchema.parse(await readPanelObject(name));
      expect(parsed.samplePrompts?.length ?? 0).toBeGreaterThanOrEqual(MIN_SAMPLE_PROMPTS);
      expect((parsed.decisionArtifact ?? "").trim().length).toBeGreaterThan(0);
      expect(parsed.tags?.length ?? 0).toBeGreaterThan(0);
    });

    it("is not flagged as a regulated domain", async () => {
      const parsed = PanelDefinitionSchema.parse(await readPanelObject(name));
      expect(parsed.regulatedDomain).toBeUndefined();
    });

    it("passes panel-lint at the OFFICIAL bar with zero errors", async () => {
      const result = lintPanelDefinition(await readPanelObject(name), { official: true });
      const errors = result.findings.filter((finding) => finding.severity === "error");
      // An empty array gives a readable diff of any offending findings.
      expect(errors).toEqual([]);
      expect(result.errorCount).toBe(0);
      expect(result.ok).toBe(true);
    });
  });
}
