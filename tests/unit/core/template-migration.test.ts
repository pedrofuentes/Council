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
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
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

    it("returns true when YAML files exist on disk but expert_library DB table is empty (DB reset)", async () => {
      // First migration populates both filesystem and DB.
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
      expect(await isMigrationNeeded(dataHome, db)).toBe(false);

      // Simulate a DB wipe while files remain on disk.
      await db.deleteFrom("panel_members").execute();
      await db.deleteFrom("panel_library").execute();
      await db.deleteFrom("expert_library").execute();

      // Filesystem-only check still reports "migrated" (files present)…
      expect(await isMigrationNeeded(dataHome)).toBe(false);
      // …but the DB-aware check correctly demands a re-register pass.
      expect(await isMigrationNeeded(dataHome, db)).toBe(true);
    });

    it("returns true when expert_library survives but panel_library was wiped", async () => {
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
      expect(await isMigrationNeeded(dataHome, db)).toBe(false);

      // Targeted wipe: panel registry only, leaving experts intact.
      await db.deleteFrom("panel_members").execute();
      await db.deleteFrom("panel_library").execute();

      expect(await isMigrationNeeded(dataHome, db)).toBe(true);
    });
  });

  describe("DB-reset recovery (re-register from preserved YAML)", () => {
    it("re-registers expert_library rows from on-disk YAML and preserves user edits", async () => {
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });

      // User edits the on-disk expert YAML — bumping displayName.
      const expertsDir = path.join(dataHome, "experts");
      const yamlFiles = (await fs.readdir(expertsDir)).filter((f) =>
        f.endsWith(".yaml"),
      );
      const firstFile = yamlFiles[0];
      if (!firstFile) throw new Error("expected migrated expert yaml");
      const editedSlug = firstFile.replace(/\.yaml$/, "");
      const editedPath = path.join(expertsDir, firstFile);
      const raw = await fs.readFile(editedPath, "utf-8");
      const parsed = yaml.parse(raw) as Record<string, unknown>;
      parsed["displayName"] = "User-Edited Name";
      await fs.writeFile(editedPath, yaml.stringify(parsed), "utf-8");

      // Wipe the DB to simulate a reset.
      await db.deleteFrom("panel_members").execute();
      await db.deleteFrom("panel_library").execute();
      await db.deleteFrom("expert_library").execute();

      // Re-run migration; it must re-register from disk content.
      const lib2 = new FileExpertLibrary(dataHome, db);
      await migrateBuiltInTemplates(dataHome, lib2, db, { quiet: true });

      const row = await db
        .selectFrom("expert_library")
        .selectAll()
        .where("slug", "=", editedSlug)
        .executeTakeFirstOrThrow();
      // The DB metadata must reflect the on-disk file (not the bundled template).
      expect(row.display_name).toBe("User-Edited Name");
      // The on-disk YAML must NOT have been overwritten.
      const afterRaw = await fs.readFile(editedPath, "utf-8");
      const after = yaml.parse(afterRaw) as Record<string, unknown>;
      expect(after["displayName"]).toBe("User-Edited Name");
    });

    it("re-registers panel_library rows from on-disk panel YAML when files exist but DB is wiped", async () => {
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });

      const panelsDir = path.join(dataHome, "panels");
      const sample = (await fs.readdir(panelsDir)).filter((f) =>
        f.endsWith(".yaml"),
      )[0];
      if (!sample) throw new Error("expected migrated panel yaml");
      const sampleName = sample.replace(/\.yaml$/, "");
      const samplePath = path.join(panelsDir, sample);

      // User edits the panel description.
      const raw = await fs.readFile(samplePath, "utf-8");
      const parsed = yaml.parse(raw) as Record<string, unknown>;
      parsed["description"] = "Customised by the user";
      await fs.writeFile(samplePath, yaml.stringify(parsed), "utf-8");

      await db.deleteFrom("panel_members").execute();
      await db.deleteFrom("panel_library").execute();
      await db.deleteFrom("expert_library").execute();

      const lib2 = new FileExpertLibrary(dataHome, db);
      await migrateBuiltInTemplates(dataHome, lib2, db, { quiet: true });

      const row = await db
        .selectFrom("panel_library")
        .selectAll()
        .where("name", "=", sampleName)
        .executeTakeFirstOrThrow();
      expect(row.description).toBe("Customised by the user");
      // The on-disk YAML is preserved.
      const afterRaw = await fs.readFile(samplePath, "utf-8");
      const after = yaml.parse(afterRaw) as Record<string, unknown>;
      expect(after["description"]).toBe("Customised by the user");
    });

    it("refreshes existing panel_library description from on-disk YAML when expert tables were wiped", async () => {
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });

      const panelsDir = path.join(dataHome, "panels");
      const sample = (await fs.readdir(panelsDir)).filter((f) =>
        f.endsWith(".yaml"),
      )[0];
      if (!sample) throw new Error("expected migrated panel yaml");
      const sampleName = sample.replace(/\.yaml$/, "");
      const samplePath = path.join(panelsDir, sample);

      // User edits the panel description on disk.
      const raw = await fs.readFile(samplePath, "utf-8");
      const parsed = yaml.parse(raw) as Record<string, unknown>;
      parsed["description"] = "Edited after migration";
      await fs.writeFile(samplePath, yaml.stringify(parsed), "utf-8");

      // Wipe ONLY the expert tables — panel_library row survives but its
      // description is now stale (matches the original template).
      await db.deleteFrom("panel_members").execute();
      await db.deleteFrom("expert_library").execute();

      const lib2 = new FileExpertLibrary(dataHome, db);
      await migrateBuiltInTemplates(dataHome, lib2, db, { quiet: true });

      const row = await db
        .selectFrom("panel_library")
        .selectAll()
        .where("name", "=", sampleName)
        .executeTakeFirstOrThrow();
      expect(row.description).toBe("Edited after migration");
    });
  });

  describe("migrateBuiltInTemplates()", () => {
    it("extracts experts from all 5 built-in panels", async () => {
      const result = await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
      expect(result.panelsMigrated).toBe(5);
      expect(result.expertsExtracted).toBeGreaterThanOrEqual(15);

      const expertsDir = path.join(dataHome, "experts");
      const files = await fs.readdir(expertsDir);
      expect(files.filter((f) => f.endsWith(".yaml")).length).toBe(
        result.expertsExtracted,
      );
    });

    it("writes standalone expert YAMLs that pass ExpertDefinitionSchema", async () => {
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
      const expertsDir = path.join(dataHome, "experts");
      const files = (await fs.readdir(expertsDir)).filter((f) => f.endsWith(".yaml"));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const def = await readYaml<unknown>(path.join(expertsDir, f));
        expect(() => ExpertDefinitionSchema.parse(def)).not.toThrow();
      }
    });

    it("writes user panel YAMLs that reference slugs (not inline definitions)", async () => {
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
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
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
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
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
      const experts = await db.selectFrom("expert_library").select("slug").execute();
      const slugs = experts.map((e) => e.slug);
      const unique = new Set(slugs);
      expect(slugs.length).toBe(unique.size);
    });

    it("disambiguates different experts that share a slug", async () => {
      // architecture-review.sre and incident-postmortem.sre have different
      // role/expertise — both must end up in the library with distinct slugs.
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
      const experts = await db.selectFrom("expert_library").select("slug").execute();
      const slugs = experts.map((e) => e.slug);
      // First-occurrence keeps the original slug; subsequent different ones
      // get a panel-context suffix (e.g. `sre-incident-postmortem`).
      expect(slugs).toContain("sre");
      const sreVariants = slugs.filter((s) => s === "sre" || s.startsWith("sre-"));
      expect(sreVariants.length).toBeGreaterThanOrEqual(2);
    });

    it("is idempotent — running twice produces the same state", async () => {
      const first = await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
      const expertsAfterFirst = (
        await fs.readdir(path.join(dataHome, "experts"))
      ).filter((f) => f.endsWith(".yaml")).length;
      const panelsAfterFirst = (
        await fs.readdir(path.join(dataHome, "panels"))
      ).filter((f) => f.endsWith(".yaml")).length;

      const second = await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
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

      const result = await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
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

      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
      const after = await fs.readFile(existing, "utf-8");
      expect(after).toBe(customContent);
    });

    it("returns accurate counts in MigrationResult", async () => {
      const result = await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
      expect(result.panelsMigrated).toBe(5);
      expect(result.expertsExtracted).toBeGreaterThan(0);
      expect(result.skipped).toBe(0);
      expect(typeof result.duplicatesUnified).toBe("number");
    });

    it("unifies identical experts shared across two panels (duplicatesUnified > 0)", async () => {
      // Use an injected loader so we can guarantee two panels share an
      // identical inline definition — the production built-ins don't.
      const shared: ExpertDefinition = {
        slug: "shared-expert",
        displayName: "Shared Expert",
        role: "An expert appearing in two panels with identical config",
        kind: "generic",
        expertise: {
          weightedEvidence: ["evidence A"],
          referenceCases: [],
          notExpertIn: [],
        },
        epistemicStance: "consistent",
      };
      const stubLoader = async (name: string) => ({
        name,
        experts: [shared],
      });

      const result = await migrateBuiltInTemplates(dataHome, lib, db, {
        quiet: true,
        panelNames: ["panel-a", "panel-b"],
        loadPanel: stubLoader,
      });

      expect(result.panelsMigrated).toBe(2);
      expect(result.expertsExtracted).toBe(1);
      expect(result.duplicatesUnified).toBe(1);

      const experts = await db.selectFrom("expert_library").select("slug").execute();
      expect(experts.map((e) => e.slug)).toEqual(["shared-expert"]);

      const members = await db
        .selectFrom("panel_members")
        .selectAll()
        .orderBy("panel_name", "asc")
        .execute();
      expect(members.map((m) => m.panel_name)).toEqual(["panel-a", "panel-b"]);
      expect(members.every((m) => m.expert_slug === "shared-expert")).toBe(true);
    });

    it("migrated panels load via loadPanel + resolveExperts end-to-end", async () => {
      // After migration, the production loader must be able to read every
      // panel and the library must resolve every slug reference back to
      // the original built-in expert definition.
      const { loadPanel, resolveExperts, loadTemplate } = await import(
        "../../../src/core/template-loader.js"
      );

      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });

      for (const name of BUILTIN_PANELS) {
        const panel = await loadPanel(name, dataHome);
        // Every entry must be a slug reference (migration shape).
        expect(panel.experts.every((e) => typeof e === "string")).toBe(true);
        const { resolved, missing } = await resolveExperts(panel.experts, lib);
        expect(missing).toEqual([]);
        expect(resolved.length).toBe(panel.experts.length);

        // Every resolved expert matches an inline expert in the original
        // built-in template (by content, not by slug — disambiguation may
        // have suffixed the slug).
        const original = await loadTemplate(name);
        for (let i = 0; i < resolved.length; i++) {
          const r = resolved[i] as ExpertDefinition;
          const o = original.experts[i] as ExpertDefinition;
          expect(r.displayName).toBe(o.displayName);
          expect(r.role).toBe(o.role);
          expect(r.epistemicStance).toBe(o.epistemicStance);
        }
      }
    });
  });
});

