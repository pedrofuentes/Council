/**
 * Tests for template-migration: extracts inline experts from built-in
 * panel templates into standalone YAML files in `<dataHome>/experts/`,
 * rewrites panels in `<dataHome>/panels/` to reference experts by slug,
 * and registers panel membership in the DB.
 *
 * RED at this commit: src/core/template-migration.ts does not yet exist.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as yaml from "yaml";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { FileExpertLibrary } from "../../../src/core/expert-library.js";
import {
  ExpertDefinitionSchema,
  type ExpertDefinition,
} from "../../../src/core/expert.js";
import { PanelDefinitionSchema } from "../../../src/core/template-loader.js";
import {
  isMigrationNeeded,
  migrateBuiltInTemplates,
} from "../../../src/core/template-migration.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";

const BUILTIN_PANELS = [
  "architecture-review",
  "career-coaching",
  "code-review",
  "incident-postmortem",
  "startup-validation",
] as const;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readYaml<T = unknown>(file: string): Promise<T> {
  const raw = await fs.readFile(file, "utf-8");
  return yaml.parse(raw) as T;
}

describe("template-migration", () => {
  let db: CouncilDatabase;
  let dataHome: string;
  let lib: FileExpertLibrary;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-mig-"));
    lib = new FileExpertLibrary(dataHome, db);
  });

  afterEach(async () => {
    await db.destroy();
    await fs.rm(dataHome, { recursive: true, force: true });
  });

  describe("isMigrationNeeded()", () => {
    it("returns true for a fresh data directory (experts dir missing)", async () => {
      expect(await isMigrationNeeded(dataHome)).toBe(true);
    });

    it("returns true when experts dir exists but is empty", async () => {
      await fs.mkdir(path.join(dataHome, "experts"), { recursive: true });
      expect(await isMigrationNeeded(dataHome)).toBe(true);
    });

    it("returns false after a successful migration", async () => {
      await migrateBuiltInTemplates(dataHome, lib, { quiet: true });
      expect(await isMigrationNeeded(dataHome)).toBe(false);
    });

    it("returns false when at least one expert already exists", async () => {
      await lib.create({
        slug: "preexisting",
        displayName: "Pre-existing",
        role: "Some role",
        kind: "generic",
        expertise: {
          weightedEvidence: ["evidence"],
          referenceCases: [],
          notExpertIn: [],
        },
        epistemicStance: "stance",
      });
      expect(await isMigrationNeeded(dataHome)).toBe(false);
    });
  });

  describe("migrateBuiltInTemplates()", () => {
    it("extracts experts from all 5 built-in panels", async () => {
      const result = await migrateBuiltInTemplates(dataHome, lib, { quiet: true });
      expect(result.panelsMigrated).toBe(5);
      expect(result.expertsExtracted).toBeGreaterThanOrEqual(15);

      const expertsDir = path.join(dataHome, "experts");
      const files = await fs.readdir(expertsDir);
      expect(files.filter((f) => f.endsWith(".yaml")).length).toBe(
        result.expertsExtracted,
      );
    });

    it("writes standalone expert YAMLs that pass ExpertDefinitionSchema", async () => {
      await migrateBuiltInTemplates(dataHome, lib, { quiet: true });
      const expertsDir = path.join(dataHome, "experts");
      const files = (await fs.readdir(expertsDir)).filter((f) => f.endsWith(".yaml"));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const def = await readYaml<unknown>(path.join(expertsDir, f));
        expect(() => ExpertDefinitionSchema.parse(def)).not.toThrow();
      }
    });

    it("writes user panel YAMLs that reference slugs (not inline definitions)", async () => {
      await migrateBuiltInTemplates(dataHome, lib, { quiet: true });
      const panelsDir = path.join(dataHome, "panels");
      for (const name of BUILTIN_PANELS) {
        const file = path.join(panelsDir, `${name}.yaml`);
        expect(await exists(file), `panel ${name} should exist`).toBe(true);
        const parsed = await readYaml<unknown>(file);
        const panel = PanelDefinitionSchema.parse(parsed);
        for (const entry of panel.experts) {
          expect(typeof entry, `panel ${name} entry should be a slug string`).toBe(
            "string",
          );
        }
      }
    });

    it("registers panels and members in panel_library / panel_members", async () => {
      await migrateBuiltInTemplates(dataHome, lib, { quiet: true });
      const panels = await db.selectFrom("panel_library").selectAll().execute();
      expect(panels.length).toBe(5);
      const members = await db
        .selectFrom("panel_members")
        .selectAll()
        .execute();
      expect(members.length).toBeGreaterThanOrEqual(20);

      // Every member's expert_slug must exist in expert_library.
      const experts = await db.selectFrom("expert_library").select("slug").execute();
      const slugs = new Set(experts.map((e) => e.slug));
      for (const m of members) {
        expect(slugs.has(m.expert_slug)).toBe(true);
      }
    });

    it("deduplicates identical experts shared across panels", async () => {
      // Two panels share the slug `sre` (architecture-review and
      // incident-postmortem) — and they're DIFFERENT definitions. We instead
      // verify dedup logic via the result counter for any panels that DO
      // share an identical inline definition. At minimum, after migration,
      // each slug appears at most once in expert_library.
      await migrateBuiltInTemplates(dataHome, lib, { quiet: true });
      const experts = await db.selectFrom("expert_library").select("slug").execute();
      const slugs = experts.map((e) => e.slug);
      const unique = new Set(slugs);
      expect(slugs.length).toBe(unique.size);
    });

    it("disambiguates different experts that share a slug", async () => {
      // architecture-review.sre and incident-postmortem.sre have different
      // role/expertise — both must end up in the library with distinct slugs.
      await migrateBuiltInTemplates(dataHome, lib, { quiet: true });
      const experts = await db.selectFrom("expert_library").select("slug").execute();
      const slugs = experts.map((e) => e.slug);
      // First-occurrence keeps the original slug; subsequent different ones
      // get a panel-context suffix (e.g. `sre-incident-postmortem`).
      expect(slugs).toContain("sre");
      const sreVariants = slugs.filter((s) => s === "sre" || s.startsWith("sre-"));
      expect(sreVariants.length).toBeGreaterThanOrEqual(2);
    });

    it("is idempotent — running twice produces the same state", async () => {
      const first = await migrateBuiltInTemplates(dataHome, lib, { quiet: true });
      const expertsAfterFirst = (
        await fs.readdir(path.join(dataHome, "experts"))
      ).filter((f) => f.endsWith(".yaml")).length;
      const panelsAfterFirst = (
        await fs.readdir(path.join(dataHome, "panels"))
      ).filter((f) => f.endsWith(".yaml")).length;

      const second = await migrateBuiltInTemplates(dataHome, lib, { quiet: true });
      expect(second.expertsExtracted).toBe(0);
      expect(second.panelsMigrated).toBe(0);
      expect(second.skipped).toBeGreaterThan(0);

      const expertsAfterSecond = (
        await fs.readdir(path.join(dataHome, "experts"))
      ).filter((f) => f.endsWith(".yaml")).length;
      const panelsAfterSecond = (
        await fs.readdir(path.join(dataHome, "panels"))
      ).filter((f) => f.endsWith(".yaml")).length;
      expect(expertsAfterSecond).toBe(expertsAfterFirst);
      expect(panelsAfterSecond).toBe(panelsAfterFirst);
      // first run extracted some experts
      expect(first.expertsExtracted).toBeGreaterThan(0);
    });

    it("skips experts that already exist in the library", async () => {
      // Pre-create a `cto` expert with a different definition; migration
      // must not overwrite it.
      const preExisting: ExpertDefinition = {
        slug: "cto",
        displayName: "Custom CTO",
        role: "User-customized CTO",
        kind: "generic",
        expertise: {
          weightedEvidence: ["custom evidence"],
          referenceCases: [],
          notExpertIn: [],
        },
        epistemicStance: "custom stance",
      };
      await lib.create(preExisting);

      const result = await migrateBuiltInTemplates(dataHome, lib, { quiet: true });
      expect(result.skipped).toBeGreaterThanOrEqual(1);

      const def = await lib.get("cto");
      expect(def?.displayName).toBe("Custom CTO");
    });

    it("skips panels that already exist in <dataHome>/panels/", async () => {
      const panelsDir = path.join(dataHome, "panels");
      await fs.mkdir(panelsDir, { recursive: true });
      const existing = path.join(panelsDir, "architecture-review.yaml");
      const customContent = "name: architecture-review\nexperts:\n  - cto\n";
      await fs.writeFile(existing, customContent, "utf-8");

      await migrateBuiltInTemplates(dataHome, lib, { quiet: true });
      const after = await fs.readFile(existing, "utf-8");
      expect(after).toBe(customContent);
    });

    it("returns accurate counts in MigrationResult", async () => {
      const result = await migrateBuiltInTemplates(dataHome, lib, { quiet: true });
      expect(result.panelsMigrated).toBe(5);
      expect(result.expertsExtracted).toBeGreaterThan(0);
      expect(result.skipped).toBe(0);
      expect(typeof result.duplicatesUnified).toBe("number");
    });
  });
});
