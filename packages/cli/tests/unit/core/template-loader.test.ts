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
  listTemplateFiles,
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
  parseStoredPanelDefinition,
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

// Regex matching every codepoint `toSingleLineDisplay` must strip from a
// single-line terminal sink: C0 controls (incl. TAB/CR/LF), DEL, C1 controls,
// Unicode line/paragraph separators, and Bidi override/isolate chars. Same
// class asserted for the review.ts sinks (#1484).
// eslint-disable-next-line no-control-regex
const DANGEROUS_CODEPOINTS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

// Build an adversarial string exercising each rejected byte class: NUL + BEL
// (C0), ANSI CSI (ESC [ … m), DEL, C1 CSI (U+009B), TAB, CR/LF, U+2028/U+2029
// line/paragraph separators, and Bidi override (U+202E) + isolates
// (U+2066/U+2069). The `label` bookends stay printable so a test can assert the
// sink preserved legitimate content instead of discarding the whole string.
function adversarialInjection(label: string): string {
  return `${label}\x00\x07\x1B[31mANSI\x1B[0m\x7F\u009B5m\tTAB\r\nCRLF\u2028\u2029\u202eRLO\u2066LRI\u2069${label}-END`;
}

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

  it("accepts and preserves optional v1 metadata fields (backward-compatible)", () => {
    const parsed = PanelDefinitionSchema.parse({
      ...minimal,
      samplePrompts: ["What should we do?"],
      decisionArtifact: "A go/no-go recommendation with risks.",
      tags: ["engineering", "architecture"],
      regulatedDomain: "finance",
    });
    expect(parsed.samplePrompts).toEqual(["What should we do?"]);
    expect(parsed.decisionArtifact).toBe("A go/no-go recommendation with risks.");
    expect(parsed.tags).toEqual(["engineering", "architecture"]);
    expect(parsed.regulatedDomain).toBe("finance");
  });

  it("leaves the new metadata fields undefined when omitted", () => {
    const parsed = PanelDefinitionSchema.parse(minimal);
    expect(parsed.samplePrompts).toBeUndefined();
    expect(parsed.decisionArtifact).toBeUndefined();
    expect(parsed.tags).toBeUndefined();
    expect(parsed.regulatedDomain).toBeUndefined();
  });

  it("rejects an unknown regulatedDomain value", () => {
    expect(() =>
      PanelDefinitionSchema.parse({ ...minimal, regulatedDomain: "astrology" }),
    ).toThrow();
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

      it("experts have distinct expertise priors across full weightedEvidence lists (pairwise set-overlap below 50%)", async () => {
        // Sentinel pr36 finding #4 (#39): the element-0 check alone permits experts
        // that are near-identical beyond the first item. This ratchet verifies that
        // every pair of experts shares fewer than half their weighted-evidence items.
        const panel = await loadTemplate(name);
        for (const [i, a] of panel.experts.entries()) {
          for (const b of panel.experts.slice(i + 1)) {
            const setA = new Set<string>(a.expertise.weightedEvidence);
            const setB = new Set<string>(b.expertise.weightedEvidence);
            const overlap = [...setA].filter((item) => setB.has(item));
            const minLen = Math.min(setA.size, setB.size);
            const overlapRatio = minLen > 0 ? overlap.length / minLen : 0;
            expect(
              overlapRatio,
              `"${a.slug}" vs "${b.slug}": ${overlap.length}/${minLen} shared weighted-evidence items (${Math.round(overlapRatio * 100)}%) — must be < 50%`,
            ).toBeLessThan(0.5);
          }
        }
      });
    });
  }
});

describe("built-in panels directory missing vs empty (issue #38)", () => {
  it("listTemplates() throws with PANELS_DIR context when the panels dir is missing", async () => {
    const missing = path.join(os.tmpdir(), "council-no-panels-does-not-exist-38");
    await expect(listTemplates(missing)).rejects.toThrow(/panels.*director|director.*panels/i);
  });

  it("listTemplates() returns [] when the panels dir exists but is empty", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "council-empty-tpl-"));
    try {
      await expect(listTemplates(empty)).resolves.toEqual([]);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it("listTemplateFiles() throws with PANELS_DIR context when the panels dir is missing", async () => {
    const missing = path.join(os.tmpdir(), "council-no-panels-does-not-exist-38");
    await expect(listTemplateFiles(missing)).rejects.toThrow(/panels.*director|director.*panels/i);
  });

  it("listTemplateFiles() returns [] when the panels dir exists but is empty", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "council-empty-tpl-"));
    try {
      await expect(listTemplateFiles(empty)).resolves.toEqual([]);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
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
    expect(panel.defaults?.model).toBe("claude-sonnet-4.5");
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

  it("omits internal filesystem paths from loadTemplate error message", async () => {
    let captured: Error | undefined;
    try {
      await loadTemplate("nonexistent-tpl-xyz");
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeInstanceOf(PanelNotFoundError);
    const msg = captured?.message ?? "";
    expect(msg).toContain("nonexistent-tpl-xyz");
    // No absolute paths, drive letters, or path separators leaked
    expect(msg).not.toMatch(/[A-Za-z]:\\/);
    expect(msg).not.toContain("/panels");
    expect(msg).not.toContain("\\panels");
  });

  it("includes available templates in loadTemplate error message", async () => {
    let captured: Error | undefined;
    try {
      await loadTemplate("nonexistent-tpl-xyz");
    } catch (err) {
      captured = err as Error;
    }
    const msg = captured?.message ?? "";
    expect(msg).toMatch(/Available:/i);
    // At least one shipped template name should be listed
    expect(msg).toContain("code-review");
  });

  it("suggests a close match (did-you-mean) for typos in loadTemplate", async () => {
    // "code-reviw" is one character off from "code-review"
    let captured: Error | undefined;
    try {
      await loadTemplate("code-reviw");
    } catch (err) {
      captured = err as Error;
    }
    const msg = captured?.message ?? "";
    expect(msg).toMatch(/did you mean/i);
    expect(msg).toContain("code-review");
  });

  it("omits internal filesystem paths from loadUserPanel error message", async () => {
    const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-pnf-userpath-"));
    try {
      await fs.mkdir(path.join(dataHome, "panels"), { recursive: true });
      let captured: Error | undefined;
      try {
        await loadUserPanel("ghost", dataHome);
      } catch (err) {
        captured = err as Error;
      }
      expect(captured).toBeInstanceOf(PanelNotFoundError);
      const msg = captured?.message ?? "";
      expect(msg).toContain("ghost");
      // No absolute paths leaked from the user data home
      expect(msg).not.toContain(dataHome);
      expect(msg).not.toMatch(/[A-Za-z]:\\/);
    } finally {
      await fs.rm(dataHome, { recursive: true, force: true });
    }
  });

  it("includes available user panels in loadUserPanel error when some exist", async () => {
    const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-pnf-userlist-"));
    try {
      const panelsDir = path.join(dataHome, "panels");
      await fs.mkdir(panelsDir, { recursive: true });
      await fs.writeFile(
        path.join(panelsDir, "my-panel.yaml"),
        "name: My Panel\nexperts:\n  - slug: e1\n    name: E1\n    role: r\n    expertise:\n      domain: d\n",
        "utf8",
      );
      let captured: Error | undefined;
      try {
        await loadUserPanel("ghost", dataHome);
      } catch (err) {
        captured = err as Error;
      }
      const msg = captured?.message ?? "";
      expect(msg).toMatch(/Available:/i);
      expect(msg).toContain("my-panel");
    } finally {
      await fs.rm(dataHome, { recursive: true, force: true });
    }
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

  it("collapses adversarial bytes in source and slug references to one display line (#1484)", () => {
    // safeSource + safeSlugs are single-line terminal sinks: `source` is an
    // untrusted resolved file path and the slug strings come from parsed YAML,
    // both of which can carry terminal-injection payloads. A reversion of
    // either `toSingleLineDisplay(...)` call to raw interpolation would leak the
    // control/bidi/line-break bytes below into the thrown Error and fail these
    // assertions.
    const evilSource = adversarialInjection("src");
    const panel: PanelDefinition = PanelDefinitionSchema.parse({
      name: "p",
      experts: [adversarialInjection("slug")],
    });

    let thrown: unknown;
    try {
      assertAllInline(panel, evilSource);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // No C0/C1/DEL/bidi/line-or-paragraph-separator byte survives to the sink.
    expect(message).not.toMatch(DANGEROUS_CODEPOINTS);
    // The whole surfaced message renders on a single terminal line.
    expect(message.split("\n")).toHaveLength(1);
    // Legitimate, printable content from both sinks is preserved.
    expect(message).toContain("src-END");
    expect(message).toContain("slug-END");
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

describe("parseStoredPanelDefinition() — corrupt vs absent (#1063)", () => {
  it("reports malformed (non-JSON) config_json as invalid, NOT absent", () => {
    // A truncated / corrupted config_json must be distinguishable from a
    // legacy session that simply predates the panel-save feature — otherwise
    // the operator sees a misleading "this session predates the feature"
    // message instead of a corruption diagnostic (#1063).
    const result = parseStoredPanelDefinition("{ definition: <truncated");
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.message).toMatch(/json/i);
    }
  });

  it("reports empty-string config_json as invalid (JSON.parse throws), NOT absent", () => {
    const result = parseStoredPanelDefinition("");
    expect(result.kind).toBe("invalid");
  });

  it("still reports a well-formed config_json WITHOUT a definition key as absent", () => {
    // Genuine legacy sessions store valid JSON (template/mode/engine) but no
    // `definition` — that MUST remain `absent`, not be re-labelled corrupt.
    const result = parseStoredPanelDefinition(
      JSON.stringify({ template: "architecture-review", mode: "freeform", engine: "mock" }),
    );
    expect(result.kind).toBe("absent");
  });

  it("reports a present-but-schema-invalid definition as invalid with a message", () => {
    const result = parseStoredPanelDefinition(JSON.stringify({ definition: { name: "" } }));
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});
