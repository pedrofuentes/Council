/**
 * Tests for the panel template loader.
 *
 * - PanelDefinitionSchema validates: name, description, defaults block, experts list
 * - loadTemplate("name") reads panels/<name>.yaml and returns typed PanelDefinition
 * - loadTemplate throws descriptive error for unknown name
 * - Each shipped template (architecture-review, startup-validation, code-review,
 *   incident-postmortem, career-coaching) parses with 3-4 experts whose
 *   expertise priors are distinct
 * - listTemplates() returns the names of all bundled templates
 *
 * RED at this commit: src/core/template-loader.ts and panels/*.yaml
 * do not yet exist.
 */
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  listTemplates,
  loadTemplate,
  loadTemplateFromFile,
  PanelDefinitionSchema,
  type PanelDefinition,
} from "../../../src/core/template-loader.js";

const MIN_EXPERTS = 3;
const MAX_EXPERTS = 4;
const EXPECTED_TEMPLATES = [
  "architecture-review",
  "startup-validation",
  "code-review",
  "incident-postmortem",
  "career-coaching",
] as const;

describe("PanelDefinitionSchema", () => {
  const minimal = {
    name: "test-panel",
    description: "A test panel",
    experts: [
      {
        slug: "a",
        displayName: "Expert A",
        role: "First role",
        expertise: { weightedEvidence: ["evidence1"] },
        epistemicStance: "Stance A",
      },
      {
        slug: "b",
        displayName: "Expert B",
        role: "Second role",
        expertise: { weightedEvidence: ["evidence2"] },
        epistemicStance: "Stance B",
      },
    ],
  };

  it("accepts a minimal valid panel", () => {
    const parsed: PanelDefinition = PanelDefinitionSchema.parse(minimal);
    expect(parsed.name).toBe("test-panel");
    expect(parsed.experts).toHaveLength(2);
  });

  it("rejects empty name", () => {
    expect(() => PanelDefinitionSchema.parse({ ...minimal, name: "" })).toThrow();
  });

  it("rejects empty description", () => {
    expect(() => PanelDefinitionSchema.parse({ ...minimal, description: "" })).toThrow();
  });

  it("requires at least 2 experts", () => {
    expect(() =>
      PanelDefinitionSchema.parse({ ...minimal, experts: [minimal.experts[0]] }),
    ).toThrow();
  });

  it("rejects more than 8 experts (panel cap)", () => {
    const tooMany = Array.from({ length: 9 }, (_, i) => ({
      slug: `e${i}`,
      displayName: `Expert ${i}`,
      role: "role",
      expertise: { weightedEvidence: ["x"] },
      epistemicStance: "stance",
    }));
    expect(() => PanelDefinitionSchema.parse({ ...minimal, experts: tooMany })).toThrow();
  });

  it("rejects duplicate expert slugs within a panel", () => {
    const duplicate = {
      ...minimal,
      experts: [minimal.experts[0], { ...minimal.experts[0] }],
    };
    expect(() => PanelDefinitionSchema.parse(duplicate)).toThrow(/duplicate|unique/i);
  });

  it("accepts optional defaults block (mode, maxRounds)", () => {
    const parsed = PanelDefinitionSchema.parse({
      ...minimal,
      defaults: { mode: "structured", maxRounds: 6 },
    });
    expect(parsed.defaults?.mode).toBe("structured");
    expect(parsed.defaults?.maxRounds).toBe(6);
  });

  it("rejects unknown debate mode", () => {
    expect(() =>
      PanelDefinitionSchema.parse({ ...minimal, defaults: { mode: "chaos" } }),
    ).toThrow();
  });
});

describe("loadTemplate() / listTemplates()", () => {
  it("listTemplates() returns at least the 5 expected built-in names", async () => {
    const names = await listTemplates();
    for (const expected of EXPECTED_TEMPLATES) {
      expect(names).toContain(expected);
    }
  });

  it("loadTemplate() throws a descriptive error for unknown name", async () => {
    await expect(loadTemplate("does-not-exist")).rejects.toThrow(/does-not-exist/);
  });

  it("loadTemplate() rejects path-traversal attempts (../)", async () => {
    // Sentinel pr36 finding #1: name MUST be a slug, not a path fragment.
    await expect(loadTemplate("../etc/passwd")).rejects.toThrow(/Invalid panel template name/i);
    await expect(loadTemplate("../../sensitive")).rejects.toThrow(/Invalid panel template name/i);
  });

  it("loadTemplate() rejects names with path separators or absolute roots", async () => {
    await expect(loadTemplate("foo/bar")).rejects.toThrow(/Invalid panel template name/i);
    await expect(loadTemplate("foo\\bar")).rejects.toThrow(/Invalid panel template name/i);
    await expect(loadTemplate("/etc/passwd")).rejects.toThrow(/Invalid panel template name/i);
  });

  it("loadTemplate() rejects names with uppercase, dots, or whitespace", async () => {
    await expect(loadTemplate("Foo")).rejects.toThrow(/Invalid panel template name/i);
    await expect(loadTemplate("foo.bar")).rejects.toThrow(/Invalid panel template name/i);
    await expect(loadTemplate("foo bar")).rejects.toThrow(/Invalid panel template name/i);
  });

  for (const name of EXPECTED_TEMPLATES) {
    describe(`built-in template: ${name}`, () => {
      it("loads and parses successfully", async () => {
        const panel = await loadTemplate(name);
        expect(panel.name).toBe(name);
        expect(panel.description.length).toBeGreaterThan(10);
      });

      it("has 3-4 experts (per ROADMAP §1.6 default)", async () => {
        const panel = await loadTemplate(name);
        expect(panel.experts.length).toBeGreaterThanOrEqual(MIN_EXPERTS);
        expect(panel.experts.length).toBeLessThanOrEqual(MAX_EXPERTS);
      });

      it("every expert has at least one weighted evidence entry", async () => {
        const panel = await loadTemplate(name);
        for (const expert of panel.experts) {
          expect(expert.expertise.weightedEvidence.length).toBeGreaterThanOrEqual(1);
        }
      });

      it("experts have distinct slugs (no duplicates)", async () => {
        const panel = await loadTemplate(name);
        const slugs = panel.experts.map((e) => e.slug);
        expect(new Set(slugs).size).toBe(slugs.length);
      });

      it("experts have distinct expertise priors (different first weightedEvidence)", async () => {
        const panel = await loadTemplate(name);
        const firstEvidences = panel.experts.map((e) => e.expertise.weightedEvidence[0]);
        // Distinct objective functions per Prompt Engineering Expert thesis
        expect(new Set(firstEvidences).size).toBe(firstEvidences.length);
      });
    });
  }
});

describe("loadTemplateFromFile()", () => {
  it("loads a panel from an arbitrary path", async () => {
    // Use one of the built-in templates via its absolute path
    const panelsDir = path.resolve(import.meta.dirname, "../../../panels");
    const file = path.join(panelsDir, "architecture-review.yaml");
    const panel = await loadTemplateFromFile(file);
    expect(panel.name).toBe("architecture-review");
  });

  it("throws a descriptive error when the file is missing", async () => {
    await expect(loadTemplateFromFile("/definitely/does/not/exist.yaml")).rejects.toThrow(
      /not.*exist|ENOENT|cannot find/i,
    );
  });
});
