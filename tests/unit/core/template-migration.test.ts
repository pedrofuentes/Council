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
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

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

    it("materializes inline expert definitions found in a user-overridden panel YAML during recovery", async () => {
      // First migration so the standard files exist.
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });

      // User has overridden a built-in panel YAML to embed an inline
      // expert (supported per template-loader.ts).
      const panelsDir = path.join(dataHome, "panels");
      const target = path.join(panelsDir, "architecture-review.yaml");
      const customPanel = {
        name: "architecture-review",
        description: "User-customised arch review",
        experts: [
          "cto", // existing library slug
          {
            slug: "inline-rookie",
            displayName: "Inline Rookie",
            role: "Junior reviewer added inline",
            kind: "generic" as const,
            expertise: {
              weightedEvidence: ["learning the codebase"],
              referenceCases: [],
              notExpertIn: [],
            },
            epistemicStance: "I ask basic questions a senior would skip.",
          },
        ],
      };
      await fs.writeFile(target, yaml.stringify(customPanel), "utf-8");

      // Wipe the entire DB.
      await db.deleteFrom("panel_members").execute();
      await db.deleteFrom("panel_library").execute();
      await db.deleteFrom("expert_library").execute();

      // Recovery must materialize the inline expert into the library
      // before inserting panel_members (FK to expert_library.slug).
      const lib2 = new FileExpertLibrary(dataHome, db);
      await migrateBuiltInTemplates(dataHome, lib2, db, { quiet: true });

      const inlineRow = await db
        .selectFrom("expert_library")
        .selectAll()
        .where("slug", "=", "inline-rookie")
        .executeTakeFirst();
      expect(inlineRow).toBeDefined();
      expect(inlineRow?.display_name).toBe("Inline Rookie");

      const members = await db
        .selectFrom("panel_members")
        .selectAll()
        .where("panel_name", "=", "architecture-review")
        .orderBy("position")
        .execute();
      expect(members.map((m) => m.expert_slug)).toEqual(["cto", "inline-rookie"]);
    });

    it("rejects path-traversal slugs in on-disk panel YAML during recovery", async () => {
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });

      // Plant a malicious panel YAML referencing an inline expert with
      // a path-traversal slug.
      const panelsDir = path.join(dataHome, "panels");
      const target = path.join(panelsDir, "architecture-review.yaml");
      const evil = {
        name: "architecture-review",
        description: "Malicious override",
        experts: [
          {
            slug: "../../etc-passwd",
            displayName: "Evil",
            role: "Evil",
            kind: "generic" as const,
            expertise: {
              weightedEvidence: ["x"],
              referenceCases: [],
              notExpertIn: [],
            },
            epistemicStance: "stance",
          },
        ],
      };
      await fs.writeFile(target, yaml.stringify(evil), "utf-8");

      await db.deleteFrom("panel_members").execute();
      await db.deleteFrom("panel_library").execute();
      await db.deleteFrom("expert_library").execute();

      const lib2 = new FileExpertLibrary(dataHome, db);
      await expect(
        migrateBuiltInTemplates(dataHome, lib2, db, { quiet: true }),
      ).rejects.toThrow(/invalid.*slug/i);

      // Nothing must have been registered under the traversal slug.
      const row = await db
        .selectFrom("expert_library")
        .selectAll()
        .where("slug", "=", "../../etc-passwd")
        .executeTakeFirst();
      expect(row).toBeUndefined();
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

    it("serialises concurrent invocations without duplicating data (issue #303)", async () => {
      // Two `council convene` processes racing on a fresh install both
      // pass `isMigrationNeeded` and would each try to create the same
      // expert/panel rows + write the same YAML files. Without locking,
      // one of them fails with a UNIQUE constraint violation (or worse,
      // a partially-written YAML file is observed). The migration must
      // serialise: both promises resolve, exactly one performs the
      // migration, the other observes the completed state and returns
      // a zero-count result.
      const [first, second] = await Promise.all([
        migrateBuiltInTemplates(dataHome, lib, db, { quiet: true }),
        migrateBuiltInTemplates(dataHome, lib, db, { quiet: true }),
      ]);

      // Exactly one of the two performed the migration; the other
      // entered the critical section after the work was complete and
      // recorded each panel via the idempotent skip path.
      const totalPanels = first.panelsMigrated + second.panelsMigrated;
      const totalExperts = first.expertsExtracted + second.expertsExtracted;
      expect(totalPanels).toBe(BUILTIN_PANELS.length);
      expect(totalExperts).toBeGreaterThan(0);

      // Library state must match a single migration — no duplicate rows.
      const expertRows = await db
        .selectFrom("expert_library")
        .selectAll()
        .execute();
      const panelRows = await db
        .selectFrom("panel_library")
        .selectAll()
        .execute();
      const memberRows = await db
        .selectFrom("panel_members")
        .selectAll()
        .execute();
      expect(panelRows.length).toBe(BUILTIN_PANELS.length);
      const expertSlugs = new Set(expertRows.map((r) => r.slug));
      expect(expertSlugs.size).toBe(expertRows.length);
      const memberKeys = new Set(
        memberRows.map((r) => `${r.panel_name}::${r.expert_slug}`),
      );
      expect(memberKeys.size).toBe(memberRows.length);

      // Lock file must be cleaned up.
      expect(await exists(path.join(dataHome, ".migration.lock"))).toBe(false);
    });

    it("releases the lock when the migration throws", async () => {
      const lockPath = path.join(dataHome, ".migration.lock");
      const failingLoader: (name: string) => Promise<never> = async () => {
        throw new Error("boom");
      };
      await expect(
        migrateBuiltInTemplates(dataHome, lib, db, {
          quiet: true,
          panelNames: ["architecture-review"],
          loadPanel: failingLoader,
        }),
      ).rejects.toThrow(/boom/);
      expect(await exists(lockPath)).toBe(false);
    });

    it("breaks an abandoned lock from a dead PID, even if mtime is fresh", async () => {
      // Sentinel #303 cycle 1: a 60-second age threshold would let a
      // contender delete the lock of a still-running migration that
      // happens to take longer than a minute. Liveness must be
      // determined by the holder PID, not by mtime alone.
      const lockPath = path.join(dataHome, ".migration.lock");
      // PID 2^31-1 is effectively guaranteed not to be allocated on
      // either Linux (PID_MAX_LIMIT 4194304) or Windows (PIDs are
      // multiples of 4 below 2^32).
      const DEAD_PID = 2_147_483_647;
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: DEAD_PID,
          hostname: os.hostname(),
          acquiredAt: new Date().toISOString(),
        }),
        "utf-8",
      );
      const result = await migrateBuiltInTemplates(dataHome, lib, db, {
        quiet: true,
      });
      expect(result.panelsMigrated + result.expertsExtracted).toBeGreaterThan(0);
      expect(await exists(lockPath)).toBe(false);
    });

    it("does not evict a lock owned by a live PID, regardless of age", async () => {
      const lockPath = path.join(dataHome, ".migration.lock");
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          hostname: os.hostname(),
          acquiredAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        }),
        "utf-8",
      );
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
      await fs.utimes(lockPath, tenMinAgo, tenMinAgo);
      const stillHeld = await Promise.race([
        migrateBuiltInTemplates(dataHome, lib, db, { quiet: true }).then(
          () => "completed" as const,
        ),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), 300),
        ),
      ]);
      expect(stillHeld).toBe("timeout");
      // The lock content must be untouched — proves the contender
      // didn't unlink-and-replace it.
      const observed = JSON.parse(await fs.readFile(lockPath, "utf-8")) as {
        pid: number;
      };
      expect(observed.pid).toBe(process.pid);
      // Cleanup: unlink so the dangling migration promise can proceed
      // to its own acquire (avoids hanging afterEach on an open handle).
      await fs.unlink(lockPath);
    });

    it("does not evict a lock owned by a different host, even with fresh mtime (#303 cycle 2)", async () => {
      // We cannot prove a remote PID is dead, so the lock must NOT be
      // evicted on hostname mismatch alone. Otherwise two hosts that
      // share a `dataHome` (NFS, SMB) re-enter the concurrent-migration
      // race the original fix was meant to close.
      const lockPath = path.join(dataHome, ".migration.lock");
      const remoteOwner = {
        pid: 12345,
        hostname: "__not-this-host__",
        acquiredAt: new Date().toISOString(),
      };
      await fs.writeFile(lockPath, JSON.stringify(remoteOwner), "utf-8");
      const stillHeld = await Promise.race([
        migrateBuiltInTemplates(dataHome, lib, db, { quiet: true }).then(
          () => "completed" as const,
        ),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), 300),
        ),
      ]);
      expect(stillHeld).toBe("timeout");
      const observed = JSON.parse(await fs.readFile(lockPath, "utf-8")) as {
        hostname: string;
      };
      expect(observed.hostname).toBe(remoteOwner.hostname);
      await fs.unlink(lockPath);
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

  // ─────────────────────────────────────────────────────────────────────
  // #563: when an inline expert in an on-disk panel YAML fails schema
  // validation but has a `slug` field, parseOnDiskPanel falls back to
  // treating it as a slug reference. That fallback is now non-silent:
  // a warning is logged so users see WHY their inline definition was
  // not materialised.
  // ─────────────────────────────────────────────────────────────────────
  describe("inline expert fallback warning (#563)", () => {
    it("logs a warning when an inline expert fails schema validation but has a slug", async () => {
      // Seed standard files so re-running migration enters the DB-reset
      // recovery path that calls parseOnDiskPanel.
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });

      // Pre-create a library expert whose slug matches the malformed
      // inline expert. parseOnDiskPanel's fallback treats the inline
      // entry as a slug reference; registerPanelFromDisk later inserts
      // panel_members with FK to expert_library, so the slug must
      // exist.
      await lib.create({
        slug: "broken-inline",
        displayName: "Fallback Target",
        role: "Resolved via slug fallback",
        kind: "generic",
        expertise: {
          weightedEvidence: ["fallback evidence"],
          referenceCases: [],
          notExpertIn: [],
        },
        epistemicStance: "fallback stance",
      });

      // Plant a panel YAML containing an inline expert that fails
      // ExpertDefinitionSchema (missing required fields) but has a
      // `slug` field. parseOnDiskPanel's fallback uses the slug.
      const panelsDir = path.join(dataHome, "panels");
      const target = path.join(panelsDir, "architecture-review.yaml");
      const malformedPanel = {
        name: "architecture-review",
        description: "Broken inline expert",
        experts: [
          {
            slug: "broken-inline",
            // intentionally missing role, expertise, epistemicStance,
            // kind so ExpertDefinitionSchema.safeParse fails.
            displayName: "Broken Inline",
          },
        ],
      };
      await fs.writeFile(target, yaml.stringify(malformedPanel), "utf-8");

      // Wipe panel DB rows so DB-reset recovery runs (which is what
      // calls parseOnDiskPanel). Keep expert_library intact so the
      // fallback slug resolves.
      await db.deleteFrom("panel_members").execute();
      await db.deleteFrom("panel_library").execute();

      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      let messages: string[] = [];
      try {
        await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
        messages = warnSpy.mock.calls.map((c) => String(c[0] ?? ""));
      } finally {
        warnSpy.mockRestore();
      }

      // The fix must surface the validation failure as a warning to
      // console.warn with the [template-migration] prefix + the slug
      // that fell back. Without the fix, the fallback is silent and
      // the spy receives zero calls referencing the broken inline
      // expert.
      const matching = messages.filter(
        (m) => m.includes("[template-migration]") && m.includes("broken-inline"),
      );
      expect(matching.length).toBeGreaterThan(0);
    });
  });
});

