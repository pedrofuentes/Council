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
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import type { ExpertLibrary } from "../../../src/core/expert-library.js";
import type { ExpertDefinition } from "../../../src/core/expert.js";
import {
  assertAllInline,
  listTemplates,
  listUserPanels,
  loadPanel,
  loadTemplate,
  loadTemplateFromFile,
  loadUserPanel,
  PanelDefaultsSchema,
  PanelDefinitionSchema,
  PanelExpertEntrySchema,
  PanelNotFoundError,
  resolveExperts,
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

  it("rejects empty description but accepts omitted description", () => {
    expect(() => PanelDefinitionSchema.parse({ ...minimal, description: "" })).toThrow();
    const { description: _unused, ...withoutDesc } = minimal;
    const parsed = PanelDefinitionSchema.parse(withoutDesc);
    expect(parsed.description).toBeUndefined();
  });

  it("requires at least 1 expert", () => {
    expect(() => PanelDefinitionSchema.parse({ ...minimal, experts: [] })).toThrow();
  });

  it("accepts a single-expert panel (min 1)", () => {
    const parsed = PanelDefinitionSchema.parse({
      ...minimal,
      experts: [minimal.experts[0]],
    });
    expect(parsed.experts).toHaveLength(1);
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

  it("PanelDefaultsSchema accepts model field", () => {
    const parsed = PanelDefaultsSchema.parse({
      mode: "structured",
      maxRounds: 6,
      model: "claude-haiku-4.5",
    });
    expect(parsed.model).toBe("claude-haiku-4.5");
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

// ---------------------------------------------------------------------------
// Panel Composition Model (Roadmap 4.2)
// ---------------------------------------------------------------------------

function makeInlineExpert(slug: string): ExpertDefinition {
  return {
    slug,
    displayName: `Expert ${slug}`,
    role: `Role for ${slug}`,
    expertise: { weightedEvidence: [`evidence-${slug}`], referenceCases: [], notExpertIn: [] },
    epistemicStance: `Stance for ${slug}`,
  };
}

describe("PanelExpertEntrySchema", () => {
  it("accepts a non-empty slug string", () => {
    expect(PanelExpertEntrySchema.parse("cto")).toBe("cto");
  });

  it("rejects an empty string", () => {
    expect(() => PanelExpertEntrySchema.parse("")).toThrow();
  });

  it("accepts a full inline ExpertDefinition", () => {
    const def = makeInlineExpert("skeptic");
    const parsed = PanelExpertEntrySchema.parse(def);
    expect(typeof parsed === "object" ? parsed.slug : parsed).toBe("skeptic");
  });
});

describe("PanelDefinitionSchema — slug references and mixed entries", () => {
  const base = {
    name: "p",
    description: "desc",
  } as const;

  it("accepts a panel of only slug references", () => {
    const parsed = PanelDefinitionSchema.parse({
      ...base,
      experts: ["alpha", "bravo"],
    });
    expect(parsed.experts).toEqual(["alpha", "bravo"]);
  });

  it("accepts a panel mixing slug references and inline definitions", () => {
    const parsed = PanelDefinitionSchema.parse({
      ...base,
      experts: ["alpha", makeInlineExpert("bravo")],
    });
    expect(parsed.experts).toHaveLength(2);
    expect(typeof parsed.experts[0]).toBe("string");
    expect(typeof parsed.experts[1]).toBe("object");
  });

  it("detects duplicate slugs across string and inline entries", () => {
    expect(() =>
      PanelDefinitionSchema.parse({
        ...base,
        experts: ["alpha", makeInlineExpert("alpha")],
      }),
    ).toThrow(/duplicate|unique/i);
  });

  it("detects duplicate slugs across two string entries", () => {
    expect(() =>
      PanelDefinitionSchema.parse({
        ...base,
        experts: ["alpha", "alpha"],
      }),
    ).toThrow(/duplicate|unique/i);
  });

  it("rejects more than 8 experts (mixed)", () => {
    const tooMany = ["a", "b", "c", "d", "e", "f", "g", "h", makeInlineExpert("i")];
    expect(() => PanelDefinitionSchema.parse({ ...base, experts: tooMany })).toThrow();
  });
});

class StubLibrary implements Partial<ExpertLibrary> {
  constructor(private readonly experts: ReadonlyMap<string, ExpertDefinition>) {}
  async get(slug: string): Promise<ExpertDefinition | null> {
    return this.experts.get(slug) ?? null;
  }
}

function stubLibrary(...defs: readonly ExpertDefinition[]): ExpertLibrary {
  const map = new Map<string, ExpertDefinition>();
  for (const d of defs) map.set(d.slug, d);
  return new StubLibrary(map) as unknown as ExpertLibrary;
}

describe("resolveExperts()", () => {
  it("resolves slug references from the library", async () => {
    const alpha = makeInlineExpert("alpha");
    const bravo = makeInlineExpert("bravo");
    const lib = stubLibrary(alpha, bravo);
    const { resolved, missing } = await resolveExperts(["alpha", "bravo"], lib);
    expect(missing).toEqual([]);
    expect(resolved).toEqual([alpha, bravo]);
  });

  it("passes inline definitions through unchanged", async () => {
    const inline = makeInlineExpert("inline");
    const lib = stubLibrary();
    const { resolved, missing } = await resolveExperts([inline], lib);
    expect(missing).toEqual([]);
    expect(resolved).toEqual([inline]);
  });

  it("reports missing slugs without aborting", async () => {
    const alpha = makeInlineExpert("alpha");
    const lib = stubLibrary(alpha);
    const { resolved, missing } = await resolveExperts(["alpha", "ghost"], lib);
    expect(missing).toEqual(["ghost"]);
    expect(resolved).toEqual([alpha]);
  });

  it("handles a mix of slugs and inline entries", async () => {
    const alpha = makeInlineExpert("alpha");
    const inline = makeInlineExpert("inline");
    const lib = stubLibrary(alpha);
    const { resolved, missing } = await resolveExperts(["alpha", inline], lib);
    expect(missing).toEqual([]);
    expect(resolved).toEqual([alpha, inline]);
  });

  it("returns empty arrays when given no entries", async () => {
    const { resolved, missing } = await resolveExperts([], stubLibrary());
    expect(resolved).toEqual([]);
    expect(missing).toEqual([]);
  });
});

describe("User panel loading (loadUserPanel / listUserPanels / loadPanel)", () => {
  let dataHome: string;
  let panelsDir: string;

  beforeEach(async () => {
    dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-panel-"));
    panelsDir = path.join(dataHome, "panels");
    await fs.mkdir(panelsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dataHome, { recursive: true, force: true });
  });

  async function writePanel(name: string, content: string): Promise<void> {
    await fs.writeFile(path.join(panelsDir, `${name}.yaml`), content, "utf-8");
  }

  it("loadUserPanel() reads <dataHome>/panels/<name>.yaml", async () => {
    await writePanel(
      "my-panel",
      `name: my-panel
description: a user panel
experts:
  - alpha
  - bravo
`,
    );
    const panel = await loadUserPanel("my-panel", dataHome);
    expect(panel.name).toBe("my-panel");
    expect(panel.experts).toEqual(["alpha", "bravo"]);
  });

  it("loadUserPanel() also accepts .yml extension", async () => {
    await fs.writeFile(
      path.join(panelsDir, "alt.yml"),
      `name: alt
experts:
  - solo
`,
      "utf-8",
    );
    const panel = await loadUserPanel("alt", dataHome);
    expect(panel.name).toBe("alt");
  });

  it("loadUserPanel() throws for a missing panel", async () => {
    await expect(loadUserPanel("ghost", dataHome)).rejects.toThrow(/ghost|not found/i);
  });

  it("loadUserPanel() rejects path-traversal attempts", async () => {
    await expect(loadUserPanel("../etc/passwd", dataHome)).rejects.toThrow(
      /Invalid panel template name/i,
    );
    await expect(loadUserPanel("foo/bar", dataHome)).rejects.toThrow(
      /Invalid panel template name/i,
    );
  });

  it("listUserPanels() returns names without extension, sorted", async () => {
    await writePanel("zeta", "name: zeta\nexperts: [solo]\n");
    await writePanel("alpha", "name: alpha\nexperts: [solo]\n");
    await fs.writeFile(path.join(panelsDir, "ignored.txt"), "not yaml", "utf-8");
    const names = await listUserPanels(dataHome);
    expect(names).toEqual(["alpha", "zeta"]);
  });

  it("listUserPanels() returns an empty array when the directory is missing", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "council-empty-"));
    try {
      const names = await listUserPanels(empty);
      expect(names).toEqual([]);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it("loadPanel() prefers a user panel over a built-in template with the same name", async () => {
    await writePanel(
      "architecture-review",
      `name: architecture-review
description: overridden by user
experts:
  - my-slug
`,
    );
    const panel = await loadPanel("architecture-review", dataHome);
    expect(panel.description).toBe("overridden by user");
    expect(panel.experts).toEqual(["my-slug"]);
  });

  it("loadPanel() falls back to a built-in template when no user panel exists", async () => {
    const panel = await loadPanel("architecture-review", dataHome);
    expect(panel.name).toBe("architecture-review");
    // built-in templates use inline experts
    const firstExpert = panel.experts[0];
    expect(typeof firstExpert).toBe("object");
  });

  it("architecture-review template includes defaults.model", async () => {
    const panel = await loadPanel("architecture-review", dataHome);
    expect(panel.defaults?.model).toBe("claude-sonnet-4-20250514");
  });

  it("loadPanel() throws when neither user nor built-in panel exists", async () => {
    await expect(loadPanel("does-not-exist", dataHome)).rejects.toThrow(/does-not-exist/);
  });

  it("loadPanel() surfaces YAML parse errors verbatim (does not fall back)", async () => {
    // A user panel that fails schema validation should NOT silently fall back
    // to a built-in. The user clearly intended their panel and deserves to see
    // the real validation error.
    await writePanel(
      "architecture-review",
      `name: architecture-review
description: bad — wrong type
experts: 12345
`,
    );
    await expect(loadPanel("architecture-review", dataHome)).rejects.toThrow(
      /Invalid panel template/i,
    );
  });
});

describe("PanelNotFoundError", () => {
  it("is the error type thrown by loadUserPanel when a panel is absent", async () => {
    const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-pnf-"));
    try {
      await fs.mkdir(path.join(dataHome, "panels"), { recursive: true });
      await expect(loadUserPanel("ghost", dataHome)).rejects.toBeInstanceOf(PanelNotFoundError);
    } finally {
      await fs.rm(dataHome, { recursive: true, force: true });
    }
  });

  it("is the error type thrown by loadTemplate when a panel is absent", async () => {
    await expect(loadTemplate("definitely-not-a-real-template")).rejects.toBeInstanceOf(
      PanelNotFoundError,
    );
  });
});

describe("assertAllInline()", () => {
  it("returns a resolved panel when every entry is inline", () => {
    const panel: PanelDefinition = PanelDefinitionSchema.parse({
      name: "p",
      experts: [makeInlineExpert("a"), makeInlineExpert("b")],
    });
    const resolved = assertAllInline(panel, "test");
    expect(resolved.experts).toHaveLength(2);
    expect(resolved.experts[0]?.slug).toBe("a");
  });

  it("rejects a panel that contains any slug-reference entries", () => {
    const panel: PanelDefinition = PanelDefinitionSchema.parse({
      name: "p",
      experts: ["cto", makeInlineExpert("skeptic")],
    });
    expect(() => assertAllInline(panel, "test")).toThrow(/slug references|cto/i);
  });
});

describe("loadTemplate() rejects built-in panels with slug references", () => {
  // assertAllInline is the guard built into loadTemplate. Test via the same
  // codepath by writing a temp YAML and loading it through loadTemplateFromFile +
  // assertAllInline, mirroring exactly what loadTemplate does for built-ins.
  it("rejects panels parsed from disk that contain slug-reference entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-builtin-"));
    try {
      const file = path.join(dir, "bad-builtin.yaml");
      await fs.writeFile(
        file,
        `name: bad-builtin
description: built-ins must be inline
experts:
  - some-slug
`,
        "utf-8",
      );
      const panel = await loadTemplateFromFile(file);
      expect(() => assertAllInline(panel, file)).toThrow(/slug references|some-slug/i);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
