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
import { ExpertDefinitionSchema, type ExpertDefinition } from "../../../src/core/expert.js";
import { PanelDefinitionSchema } from "../../../src/core/template-loader.js";
import {
  isMigrationNeeded,
  migrateBuiltInTemplates,
  parseOnDiskPanel,
} from "../../../src/core/template-migration.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";

// Every panel YAML shipped in `packages/cli/panels/`. The migration scans that
// directory dynamically (no registry), so this list must stay in sync with the
// files on disk; assertions below derive their expected counts from its length.
const BUILTIN_PANELS = [
  "architecture-review",
  "brand-positioning-review",
  "career-coaching",
  "code-review",
  "enterprise-deal-review",
  "executive-strategy-board-prep",
  "fpna-budget-review",
  "growth-experiment-review",
  "hiring-decision-review",
  "incident-postmortem",
  "legal-risk-review",
  "negotiation-prep",
  "pricing-packaging-review",
  "product-strategy-review",
  "roadmap-prioritization",
  "startup-validation",
  "ux-review",
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
    await fs.rm(dataHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
      const yamlFiles = (await fs.readdir(expertsDir)).filter((f) => f.endsWith(".yaml"));
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
      const sample = (await fs.readdir(panelsDir)).filter((f) => f.endsWith(".yaml"))[0];
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
      const sample = (await fs.readdir(panelsDir)).filter((f) => f.endsWith(".yaml"))[0];
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
      await expect(migrateBuiltInTemplates(dataHome, lib2, db, { quiet: true })).rejects.toThrow(
        /invalid.*slug/i,
      );

      // Nothing must have been registered under the traversal slug.
      const row = await db
        .selectFrom("expert_library")
        .selectAll()
        .where("slug", "=", "../../etc-passwd")
        .executeTakeFirst();
      expect(row).toBeUndefined();
    });

    it("never issues an fs syscall on a path derived from a traversal slug", async () => {
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });

      // Plant a malicious panel referencing an inline expert whose slug
      // escapes <dataHome>/experts/. A correct implementation rejects the
      // slug at the parse boundary, so the recovery loop never reaches a
      // path.join(expertsDir, "../../etc-passwd.yaml") fs.access/readFile —
      // no traversal file is ever created or touched. The existing
      // /invalid.*slug/ test is also satisfied by FileExpertLibrary.create
      // downstream; this pins the syscall-avoidance property explicitly.
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
            expertise: { weightedEvidence: ["x"], referenceCases: [], notExpertIn: [] },
            epistemicStance: "stance",
          },
        ],
      };
      await fs.writeFile(target, yaml.stringify(evil), "utf-8");

      await db.deleteFrom("panel_members").execute();
      await db.deleteFrom("panel_library").execute();
      await db.deleteFrom("expert_library").execute();

      const lib2 = new FileExpertLibrary(dataHome, db);
      await expect(migrateBuiltInTemplates(dataHome, lib2, db, { quiet: true })).rejects.toThrow(
        /invalid.*slug/i,
      );

      // No file may have been written/touched at the traversal target.
      expect(await exists(path.join(dataHome, "etc-passwd.yaml"))).toBe(false);
      expect(await exists(path.join(dataHome, "experts", "../../etc-passwd.yaml"))).toBe(false);
    });

    it("parseOnDiskPanel rejects traversal slugs before any caller can touch the fs", () => {
      const evil = yaml.stringify({
        name: "p",
        experts: ["../../etc-passwd"],
      });
      expect(() => parseOnDiskPanel(evil)).toThrow(/invalid.*slug/i);

      const evilInline = yaml.stringify({
        name: "p",
        experts: [
          {
            slug: "../../etc-passwd",
            displayName: "Evil",
            role: "Evil",
            kind: "generic",
            expertise: { weightedEvidence: ["x"], referenceCases: [], notExpertIn: [] },
            epistemicStance: "stance",
          },
        ],
      });
      expect(() => parseOnDiskPanel(evilInline)).toThrow(/invalid.*slug/i);
    });
  });

  describe("migrateBuiltInTemplates()", () => {
    it("extracts experts from all built-in panels", async () => {
      const result = await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
      expect(result.panelsMigrated).toBe(BUILTIN_PANELS.length);
      expect(result.expertsExtracted).toBeGreaterThanOrEqual(15);

      const expertsDir = path.join(dataHome, "experts");
      const files = await fs.readdir(expertsDir);
      expect(files.filter((f) => f.endsWith(".yaml")).length).toBe(result.expertsExtracted);
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
          expect(typeof entry, `panel ${name} entry should be a slug string`).toBe("string");
        }
      }
    });

    it("registers panels and members in panel_library / panel_members", async () => {
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
      const panels = await db.selectFrom("panel_library").selectAll().execute();
      expect(panels.length).toBe(BUILTIN_PANELS.length);
      const members = await db.selectFrom("panel_members").selectAll().execute();
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
      const expertsAfterFirst = (await fs.readdir(path.join(dataHome, "experts"))).filter((f) =>
        f.endsWith(".yaml"),
      ).length;
      const panelsAfterFirst = (await fs.readdir(path.join(dataHome, "panels"))).filter((f) =>
        f.endsWith(".yaml"),
      ).length;

      const second = await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
      expect(second.expertsExtracted).toBe(0);
      expect(second.panelsMigrated).toBe(0);
      expect(second.skipped).toBeGreaterThan(0);

      const expertsAfterSecond = (await fs.readdir(path.join(dataHome, "experts"))).filter((f) =>
        f.endsWith(".yaml"),
      ).length;
      const panelsAfterSecond = (await fs.readdir(path.join(dataHome, "panels"))).filter((f) =>
        f.endsWith(".yaml"),
      ).length;
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
      const expertRows = await db.selectFrom("expert_library").selectAll().execute();
      const panelRows = await db.selectFrom("panel_library").selectAll().execute();
      const memberRows = await db.selectFrom("panel_members").selectAll().execute();
      expect(panelRows.length).toBe(BUILTIN_PANELS.length);
      const expertSlugs = new Set(expertRows.map((r) => r.slug));
      expect(expertSlugs.size).toBe(expertRows.length);
      const memberKeys = new Set(memberRows.map((r) => `${r.panel_name}::${r.expert_slug}`));
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
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 300)),
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
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 300)),
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
      expect(result.panelsMigrated).toBe(BUILTIN_PANELS.length);
      expect(result.expertsExtracted).toBeGreaterThan(0);
      expect(result.skipped).toBe(0);
      expect(typeof result.duplicatesUnified).toBe("number");
    });

    it("does not emit migration notices in normal mode", async () => {
      const notices: string[] = [];

      const result = await migrateBuiltInTemplates(dataHome, lib, db, {
        writeNotice: (message) => {
          notices.push(message);
        },
      });

      expect(result.panelsMigrated + result.expertsExtracted).toBeGreaterThan(0);
      expect(notices).toEqual([]);
    });

    it("emits migration notices in verbose mode", async () => {
      const notices: string[] = [];

      const result = await migrateBuiltInTemplates(dataHome, lib, db, {
        verbose: true,
        writeNotice: (message) => {
          notices.push(message);
        },
      });

      expect(notices).toEqual([
        `ℹ Migrated ${result.panelsMigrated} panels and ${result.expertsExtracted} experts to the new library format.\n`,
      ]);
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
      const { loadPanel, resolveExperts, loadTemplate } =
        await import("../../../src/core/template-loader.js");

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
  // #302: when an on-disk panel entry is object-shaped (inline expert)
  // but fails ExpertDefinitionSchema, parseOnDiskPanel must surface the
  // Zod validation error rather than silently downgrading it to a slug
  // reference — silent downgrade masks user typos. Supersedes the older
  // #563 warning-fallback behaviour.
  // ─────────────────────────────────────────────────────────────────────
  describe("inline expert schema failure surfaces Zod error (#302)", () => {
    it("throws (not silently downgrades) when an inline-shaped expert fails schema validation", async () => {
      // Seed standard files so re-running migration enters the DB-reset
      // recovery path that calls parseOnDiskPanel.
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });

      // A library expert with the same slug exists, so the OLD behaviour
      // would have happily resolved the typo'd inline entry as a slug
      // ref. The fix must still reject it because the entry is clearly
      // an attempted inline definition (object-shaped, missing fields).
      await lib.create({
        slug: "broken-inline",
        displayName: "Fallback Target",
        role: "Would-be slug fallback",
        kind: "generic",
        expertise: {
          weightedEvidence: ["fallback evidence"],
          referenceCases: [],
          notExpertIn: [],
        },
        epistemicStance: "fallback stance",
      });

      const panelsDir = path.join(dataHome, "panels");
      const target = path.join(panelsDir, "architecture-review.yaml");
      const malformedPanel = {
        name: "architecture-review",
        description: "Broken inline expert",
        experts: [
          {
            slug: "broken-inline",
            // intentionally missing role, expertise, epistemicStance so
            // ExpertDefinitionSchema.safeParse fails — a likely typo.
            displayName: "Broken Inline",
          },
        ],
      };
      await fs.writeFile(target, yaml.stringify(malformedPanel), "utf-8");

      // Wipe panel DB rows so DB-reset recovery runs (calls parseOnDiskPanel).
      await db.deleteFrom("panel_members").execute();
      await db.deleteFrom("panel_library").execute();

      // The fix must reject with a Zod-derived error that names the
      // offending slug so the user can find the typo. Without the fix the
      // call resolves silently by downgrading to a slug reference.
      await expect(migrateBuiltInTemplates(dataHome, lib, db, { quiet: true })).rejects.toThrow(
        /broken-inline/,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // #1808 (sentinel:security): the schema-validation failure path
  // interpolates an unvalidated slug label + JSON.stringify(zod issues)
  // straight into a thrown Error that reaches handleCliError ->
  // process.stderr.write. ESC/CSI/OSC/C1/DEL/bidi bytes originating in a
  // user-authored panel YAML must be stripped before they can reach the
  // terminal (escape-injection / Trojan-source), and the message must stay
  // on a single physical line so a crafted "\r\n" cannot spoof extra output.
  // ─────────────────────────────────────────────────────────────────────
  describe("thrown schema-validation error is terminal-safe (#1808)", () => {
    // C0 (except tab) / C1 / DEL / bidi override + isolate ranges — any of
    // these reaching a TTY is a terminal-injection vector.
    // eslint-disable-next-line no-control-regex
    const DANGEROUS = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;

    it("strips control / escape / bidi sequences from the thrown message", () => {
      // A malformed inline expert whose slug (used verbatim as the error
      // label) and enum-echoed `kind` both carry terminal-injection payloads:
      //   - \r\n          → line break-out
      //   - \u001b[2J     → ANSI CSI (clear screen)
      //   - \u009b31m     → C1 CSI introducer (JSON.stringify does NOT escape it)
      //   - \u202e        → RLO bidi override (Trojan Source)
      const evil = yaml.stringify({
        name: "p",
        experts: [
          {
            slug: "evil\r\n\u001b[2J\u009b31mINJECTED\u202e",
            displayName: "x",
            kind: "generic\u009b6m", // invalid enum → forces schema failure; issues JSON is sanitized defensively too
          },
        ],
      });

      let caught: unknown;
      try {
        parseOnDiskPanel(evil);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      // No raw ESC / C0 / C1 / DEL / bidi bytes may survive to the terminal.
      expect(message).not.toMatch(DANGEROUS);
      // Renders on a single physical line (no CR/LF break-out).
      expect(message.split("\n")).toHaveLength(1);
      expect(message).not.toContain("\r");
      // Still informative: the printable slug text + schema context remain.
      expect(message).toContain("INJECTED");
      expect(message).toContain("failed schema validation");
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // #1807: a malformed inline expert in ONE panel used to throw straight
  // out of the `for (const name of templateNames)` loop, skipping every
  // alphabetically-later panel. Because the earlier panels had already
  // written rows, the next run's isMigrationNeeded() short-circuited to
  // false and the skipped panels never migrated — a permanent lock-out
  // until manual file/DB deletion. Per-panel data failures must be isolated
  // so the remaining panels still migrate (the error is still surfaced).
  // ─────────────────────────────────────────────────────────────────────
  describe("per-panel data failure isolation (#1807)", () => {
    it("still migrates later panels when an earlier panel has a malformed inline expert", async () => {
      // Seed the standard files + experts on disk and in the DB.
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });

      // Corrupt the alphabetically-FIRST built-in panel with a malformed
      // inline expert (object-shaped, missing required fields) so
      // parseOnDiskPanel throws while processing it.
      const firstName = BUILTIN_PANELS[0];
      const laterName = BUILTIN_PANELS[BUILTIN_PANELS.length - 1];
      const panelsDir = path.join(dataHome, "panels");
      await fs.writeFile(
        path.join(panelsDir, `${firstName}.yaml`),
        yaml.stringify({
          name: firstName,
          description: "corrupted",
          experts: [{ slug: "broken-inline", displayName: "Broken" }],
        }),
        "utf-8",
      );

      // Wipe panel DB rows so DB-reset recovery re-registers every panel
      // from disk — the path that calls parseOnDiskPanel.
      await db.deleteFrom("panel_members").execute();
      await db.deleteFrom("panel_library").execute();

      // The malformed panel is still surfaced as an error...
      await expect(migrateBuiltInTemplates(dataHome, lib, db, { quiet: true })).rejects.toThrow(
        /broken-inline/,
      );

      // ...but an alphabetically-LATER panel must STILL have been
      // re-registered. Before the fix the throw unwound the loop and this
      // row was never written.
      const laterRow = await db
        .selectFrom("panel_library")
        .selectAll()
        .where("name", "=", laterName)
        .executeTakeFirst();
      expect(laterRow).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // #1918 (sentinel:important, security): the per-panel classification
  // boundary isolates only PanelMigrationError; every other error was
  // re-thrown RAW. Two on-disk *data* reads of user-editable files produce
  // non-PanelMigrationError errors:
  //   - the expert create/recovery read `ExpertDefinitionSchema.parse(
  //     yaml.parse(content))` (YAMLParseError / on-disk ZodError), and
  //   - the panel read via parseOnDiskPanel's `yaml.parse(content)`.
  // A `yaml` YAMLParseError.message embeds a code-frame of the offending
  // source line, so raw C1 (U+0080–U+009F, incl. 0x9B CSI / 0x9D OSC), DEL
  // (0x7F), bidi (U+202A–U+202E, U+2066–U+2069) and raw CR/LF survive into
  // the message and reach handleCliError → process.stderr.write (a bare TTY
  // sink) — a terminal escape-injection / Trojan-source vector. It also
  // aborts the loop, skipping alphabetically-later panels (residual #1807
  // lock-out). These reads must become sanitized, per-panel-isolatable
  // PanelMigrationErrors while genuine fs infra errors still propagate.
  // ─────────────────────────────────────────────────────────────────────
  describe("malformed on-disk YAML/schema is sanitized + isolated per panel (#1918)", () => {
    // C0 (except tab) / C1 / DEL / bidi override + isolate ranges — any of
    // these reaching a TTY is a terminal-injection vector.
    // eslint-disable-next-line no-control-regex
    const DANGEROUS = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;

    // Syntactically-invalid YAML (tab indentation) whose offending source
    // line — which `yaml` embeds verbatim into YAMLParseError.message's code
    // frame — carries a C1 CSI introducer (0x9B), a C1 OSC introducer (0x9D),
    // DEL (0x7F), an RLO bidi override (U+202E) and a raw CRLF.
    const MALFORMED_YAML = "experts:\n\t- slug: evil\u009b31m\u009d\u007f\u202eINJECTED\r\n";

    function makeExpert(slug: string): ExpertDefinition {
      return {
        slug,
        displayName: "Valid Expert",
        role: "A schema-valid inline expert supplied by the built-in loader",
        kind: "generic",
        expertise: { weightedEvidence: ["evidence"], referenceCases: [], notExpertIn: [] },
        epistemicStance: "stance",
      };
    }

    it("parseOnDiskPanel surfaces a terminal-safe error (not a raw YAMLParseError) for malformed YAML", () => {
      let caught: unknown;
      try {
        parseOnDiskPanel(MALFORMED_YAML);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      // No raw C1 / DEL / bidi / CR / LF may survive to the terminal...
      expect(message).not.toMatch(DANGEROUS);
      // ...and the message must render on a single physical line.
      expect(message.split("\n")).toHaveLength(1);
      expect(message).not.toContain("\r");
    });

    it("isolates + sanitizes a malformed on-disk PANEL YAML so later panels still migrate", async () => {
      await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });

      const firstName = BUILTIN_PANELS[0];
      const laterName = BUILTIN_PANELS[BUILTIN_PANELS.length - 1];
      const panelsDir = path.join(dataHome, "panels");
      // Replace the alphabetically-first panel with syntactically-invalid
      // YAML carrying terminal-injection bytes in its code frame.
      await fs.writeFile(path.join(panelsDir, `${firstName}.yaml`), MALFORMED_YAML, "utf-8");

      // Wipe panel rows so DB-reset recovery re-reads every panel from disk
      // (the parseOnDiskPanel path); keep expert rows so the malformed panel
      // read is the only failure.
      await db.deleteFrom("panel_members").execute();
      await db.deleteFrom("panel_library").execute();

      let caught: unknown;
      try {
        await migrateBuiltInTemplates(dataHome, lib, db, { quiet: true });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).not.toMatch(DANGEROUS);
      expect(message.split("\n")).toHaveLength(1);

      // The malformed panel must NOT have aborted the run: an
      // alphabetically-later panel is still re-registered.
      const laterRow = await db
        .selectFrom("panel_library")
        .selectAll()
        .where("name", "=", laterName)
        .executeTakeFirst();
      expect(laterRow).toBeDefined();
    });

    it("isolates + sanitizes a malformed on-disk EXPERT YAML (create/recovery read) per panel", async () => {
      const expertsDir = path.join(dataHome, "experts");
      await fs.mkdir(expertsDir, { recursive: true });
      // A user-editable expert file that is syntactically-invalid YAML with
      // terminal-injection bytes. The built-in loader still yields a valid
      // inline definition; the on-disk file is what is corrupt, so the
      // create-branch read at ExpertDefinitionSchema.parse(yaml.parse(...))
      // is exercised (library.get returns null → action "create").
      await fs.writeFile(path.join(expertsDir, "alpha-expert.yaml"), MALFORMED_YAML, "utf-8");

      const stubLoader = async (name: string) =>
        name === "panel-a"
          ? { name, experts: [makeExpert("alpha-expert")] }
          : { name, experts: [makeExpert("beta-expert")] };

      let caught: unknown;
      try {
        await migrateBuiltInTemplates(dataHome, lib, db, {
          quiet: true,
          panelNames: ["panel-a", "panel-b"],
          loadPanel: stubLoader,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).not.toMatch(DANGEROUS);
      expect(message.split("\n")).toHaveLength(1);

      // panel-b's expert (whose on-disk file does not exist and is freshly
      // created) must still have been registered despite panel-a's failure.
      const betaRow = await db
        .selectFrom("expert_library")
        .selectAll()
        .where("slug", "=", "beta-expert")
        .executeTakeFirst();
      expect(betaRow).toBeDefined();
    });

    it("isolates a schema-invalid on-disk EXPERT YAML (ExpertDefinitionSchema.parse) per panel", async () => {
      const expertsDir = path.join(dataHome, "experts");
      await fs.mkdir(expertsDir, { recursive: true });
      // Syntactically-valid YAML that fails ExpertDefinitionSchema (missing
      // required fields / invalid kind enum). Before the fix the ZodError is
      // re-thrown raw at the loop boundary, aborting later panels.
      const schemaInvalid = yaml.stringify({ slug: "alpha-expert", kind: "not-a-valid-kind" });
      await fs.writeFile(path.join(expertsDir, "alpha-expert.yaml"), schemaInvalid, "utf-8");

      const stubLoader = async (name: string) =>
        name === "panel-a"
          ? { name, experts: [makeExpert("alpha-expert")] }
          : { name, experts: [makeExpert("beta-expert")] };

      await expect(
        migrateBuiltInTemplates(dataHome, lib, db, {
          quiet: true,
          panelNames: ["panel-a", "panel-b"],
          loadPanel: stubLoader,
        }),
      ).rejects.toThrow();

      // Isolation: panel-b's freshly-created expert row survives the
      // schema-invalid alpha-expert read.
      const betaRow = await db
        .selectFrom("expert_library")
        .selectAll()
        .where("slug", "=", "beta-expert")
        .executeTakeFirst();
      expect(betaRow).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // #1946 (sentinel:important, security): the on-disk EXPERT schema-
  // validation failure sink (parseOnDiskExpert, template-migration.ts:582-586)
  // interpolates the expert's slug label straight into a thrown
  // PanelMigrationError that reaches handleCliError → process.stderr.write (a
  // bare TTY sink). The only pre-existing test reaching this branch (above,
  // "isolates a schema-invalid on-disk EXPERT YAML ...") asserts a benign
  // `.rejects.toThrow()` on ASCII input, so it passes even if `sanitizeForError`
  // were dropped from :584 — a NON-DISCRIMINATING oracle that would silently
  // reopen the #1918 terminal-escape-injection / Trojan-source class on this
  // branch. This test drives the create-branch read with a slug carrying the
  // full dangerous-byte class and asserts the surfaced message is stripped of
  // every control / DEL / C1 / bidi / line-separator code point AND stays on
  // one physical line, so removing the sanitizer makes it FAIL.
  // ─────────────────────────────────────────────────────────────────────
  describe("schema-validation error surface is terminal-safe with adversarial bytes (#1946)", () => {
    // Stricter than the #1808/#1918 DANGEROUS set: this also rejects TAB
    // (U+0009) and the Unicode line/paragraph separators (U+2028/U+2029) — the
    // full class that `toSingleLineDisplay` (the sanitizer backing
    // sanitizeForError) collapses. Any survivor is a terminal-injection or
    // line-break-out vector.
    // eslint-disable-next-line no-control-regex
    const DANGEROUS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

    function makeExpert(slug: string): ExpertDefinition {
      return {
        slug,
        displayName: "Valid Expert",
        role: "A schema-valid inline expert supplied by the built-in loader",
        kind: "generic",
        expertise: { weightedEvidence: ["evidence"], referenceCases: [], notExpertIn: [] },
        epistemicStance: "stance",
      };
    }

    it("strips control / DEL / C1 / bidi / TAB / line-separator bytes from the thrown schema-validation message", async () => {
      const expertsDir = path.join(dataHome, "experts");
      await fs.mkdir(expertsDir, { recursive: true });

      // The built-in loader yields an expert whose slug carries the full
      // dangerous-byte class. `sanitizeForError(slug, 100)` at :584 is the sink
      // under test:
      //   \t              → TAB (column-alignment / fake-table spoof)
      //   \r\n            → CRLF line break-out
      //   \u001b[2J       → ANSI CSI clear-screen
      //   \u009b31m\u009d → C1 CSI / OSC introducers (survive JSON, echo raw)
      //   \u007f          → DEL
      //   \u202e\u2066    → RLO bidi override + isolate (Trojan Source)
      //   \u2028          → Unicode line separator
      const evilSlug = "evil\t\r\n\u001b[2J\u009b31m\u009d\u007f\u202e\u2066\u2028INJECTED";

      // A user-editable on-disk expert file at that slug's path: syntactically
      // valid YAML that FAILS ExpertDefinitionSchema (missing required fields +
      // invalid kind enum). library.get(slug) returns null → the create branch
      // reads this file and calls parseOnDiskExpert(content, slug), reaching the
      // :582-586 schema-validation sink with the evil slug as the label.
      const schemaInvalid = yaml.stringify({ slug: "unused", kind: "not-a-valid-kind" });
      await fs.writeFile(path.join(expertsDir, `${evilSlug}.yaml`), schemaInvalid, "utf-8");

      const stubLoader = async (name: string) =>
        name === "panel-a"
          ? { name, experts: [makeExpert(evilSlug)] }
          : { name, experts: [makeExpert("beta-expert")] };

      let caught: unknown;
      try {
        await migrateBuiltInTemplates(dataHome, lib, db, {
          quiet: true,
          panelNames: ["panel-a", "panel-b"],
          loadPanel: stubLoader,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      // No raw control / DEL / C1 / bidi / line-separator byte may survive to
      // the terminal (fails if sanitizeForError is dropped from :584)...
      expect(message).not.toMatch(DANGEROUS);
      // ...and the message must render on a single physical line (the raw slug
      // embeds CR/LF, so a missing sanitizer also breaks this).
      expect(message.split("\n")).toHaveLength(1);
      expect(message).not.toContain("\r");
      // Still informative: the printable slug tail + schema context survive, so
      // the sanitizer strips the danger without gutting the diagnostic.
      expect(message).toContain("INJECTED");
      expect(message).toContain("failed schema validation");
    });
  });
});
