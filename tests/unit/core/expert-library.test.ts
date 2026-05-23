/**
 * Tests for FileExpertLibrary — CRUD over expert YAML files + DB metadata.
 *
 * Uses a temp directory per test as the dataHome and an in-memory libsql.
 *
 * RED at this commit: src/core/expert-library.ts does not yet exist.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { FileExpertLibrary } from "../../../src/core/expert-library.js";
import type { ExpertDefinition } from "../../../src/core/expert.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { ExpertLibraryRepository } from "../../../src/memory/repositories/expert-library-repo.js";

function makeDef(overrides: Partial<ExpertDefinition> = {}): ExpertDefinition {
  return {
    slug: "cto",
    displayName: "Dahlia Renner (CTO)",
    role: "Skeptical CTO with 20 years of experience",
    kind: "generic",
    expertise: {
      weightedEvidence: ["production incident data"],
      referenceCases: [],
      notExpertIn: [],
    },
    epistemicStance: "Bayesian skeptic",
    ...overrides,
  };
}

describe("FileExpertLibrary", () => {
  let db: CouncilDatabase;
  let dataHome: string;
  let lib: FileExpertLibrary;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-lib-"));
    lib = new FileExpertLibrary(dataHome, db);
  });

  afterEach(async () => {
    await db.destroy();
    await fs.rm(dataHome, { recursive: true, force: true });
  });

  describe("create()", () => {
    it("writes a YAML file and a DB row", async () => {
      await lib.create(makeDef());
      const yamlPath = path.join(dataHome, "experts", "cto.yaml");
      const content = await fs.readFile(yamlPath, "utf-8");
      expect(content).toContain("slug: cto");
      expect(content).toContain("kind: generic");
      const row = await db
        .selectFrom("expert_library")
        .selectAll()
        .where("slug", "=", "cto")
        .executeTakeFirst();
      expect(row).toBeDefined();
      expect(row?.display_name).toBe("Dahlia Renner (CTO)");
      expect(row?.kind).toBe("generic");
    });

    it("stores SHA-256 checksum of YAML content", async () => {
      await lib.create(makeDef());
      const yamlPath = path.join(dataHome, "experts", "cto.yaml");
      const content = await fs.readFile(yamlPath, "utf-8");
      const expected = createHash("sha256").update(content).digest("hex");
      const row = await db
        .selectFrom("expert_library")
        .selectAll()
        .where("slug", "=", "cto")
        .executeTakeFirstOrThrow();
      expect(row.yaml_checksum).toBe(expected);
    });

    it("throws on duplicate slug", async () => {
      await lib.create(makeDef());
      await expect(lib.create(makeDef())).rejects.toThrow(/already exists/i);
    });

    it("recreates a ghost expert when only the DB cache row remains", async () => {
      await lib.create(makeDef());
      const yamlPath = path.join(dataHome, "experts", "cto.yaml");
      await fs.unlink(yamlPath);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      expect(await lib.get("cto")).toBeNull();
      expect(await lib.list()).toEqual([]);

      await lib.create(
        makeDef({
          displayName: "Fresh CTO",
          role: "Recreated from YAML source of truth",
        }),
      );

      const recreated = await lib.get("cto");
      expect(recreated?.displayName).toBe("Fresh CTO");
      expect(recreated?.role).toBe("Recreated from YAML source of truth");

      const row = await new ExpertLibraryRepository(db).findBySlug("cto");
      expect(row?.displayName).toBe("Fresh CTO");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Recovering stale expert cache row for slug "cto"'),
      );
      warnSpy.mockRestore();
    });

    it("rejects a concurrent ghost expert recreate after the replacement YAML is claimed", async () => {
      await lib.create(makeDef());
      const yamlPath = path.join(dataHome, "experts", "cto.yaml");
      await fs.unlink(yamlPath);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const repo = (lib as any).repo as ExpertLibraryRepository;
      const originalCreate = repo.create.bind(repo);
      let callCount = 0;
      let signalFirstCreate: (() => void) | undefined;
      const firstCreateEntered = new Promise<void>((resolve) => {
        signalFirstCreate = resolve;
      });
      let releaseFirstCreate: (() => void) | undefined;
      const createSpy = vi.spyOn(repo, "create").mockImplementation(async (input) => {
        callCount += 1;
        if (callCount === 1) {
          signalFirstCreate?.();
          await new Promise<void>((resolve) => {
            releaseFirstCreate = resolve;
          });
        }
        return originalCreate(input);
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        const first = lib.create(makeDef({ displayName: "Fresh CTO" }));
        await firstCreateEntered;

        await expect(lib.create(makeDef({ displayName: "Racing CTO" }))).rejects.toThrow(/already exists/i);
        expect(createSpy).toHaveBeenCalledTimes(1);

        releaseFirstCreate?.();
        await first;

        const recreated = await lib.get("cto");
        expect(recreated?.displayName).toBe("Fresh CTO");
        const content = await fs.readFile(yamlPath, "utf-8");
        expect(content).toContain("displayName: Fresh CTO");
      } finally {
        releaseFirstCreate?.();
        createSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("rejects invalid slug (uppercase)", async () => {
      await expect(lib.create(makeDef({ slug: "BadSlug" }))).rejects.toThrow(/slug/i);
    });

    it("rejects invalid slug (spaces)", async () => {
      await expect(lib.create(makeDef({ slug: "bad slug" }))).rejects.toThrow(/slug/i);
    });

    it("rejects invalid slug (longer than 64 chars)", async () => {
      const long = "a".repeat(65);
      await expect(lib.create(makeDef({ slug: long }))).rejects.toThrow(/slug/i);
    });

    it("accepts a persona expert with personaDescription and docsPath", async () => {
      await lib.create(
        makeDef({
          slug: "sarah-vp",
          kind: "persona",
          personaDescription: "VP of Engineering I report to",
          docsPath: "~/Council/experts/sarah-vp/docs",
        }),
      );
      const def = await lib.get("sarah-vp");
      expect(def?.kind).toBe("persona");
      expect(def?.personaDescription).toBe("VP of Engineering I report to");
      expect(def?.docsPath).toBe("~/Council/experts/sarah-vp/docs");
    });
  });

  describe("get()", () => {
    it("reads and parses the YAML file", async () => {
      await lib.create(makeDef());
      const def = await lib.get("cto");
      expect(def?.slug).toBe("cto");
      expect(def?.displayName).toBe("Dahlia Renner (CTO)");
      expect(def?.kind).toBe("generic");
    });

    it("returns null when slug not present", async () => {
      const def = await lib.get("missing");
      expect(def).toBeNull();
    });
  });

  describe("list()", () => {
    it("returns all experts", async () => {
      await lib.create(makeDef({ slug: "cto" }));
      await lib.create(makeDef({ slug: "pm", displayName: "PM" }));
      const all = await lib.list();
      const slugs = all.map((e) => e.slug).sort();
      expect(slugs).toEqual(["cto", "pm"]);
    });

    it("returns empty array when no experts exist", async () => {
      const all = await lib.list();
      expect(all).toEqual([]);
    });
  });

  describe("update()", () => {
    it("rewrites YAML, updates DB row and recomputes checksum", async () => {
      await lib.create(makeDef());
      const before = await db
        .selectFrom("expert_library")
        .selectAll()
        .where("slug", "=", "cto")
        .executeTakeFirstOrThrow();

      await lib.update("cto", { displayName: "Updated Name" });
      const yamlPath = path.join(dataHome, "experts", "cto.yaml");
      const content = await fs.readFile(yamlPath, "utf-8");
      expect(content).toContain("Updated Name");

      const after = await db
        .selectFrom("expert_library")
        .selectAll()
        .where("slug", "=", "cto")
        .executeTakeFirstOrThrow();
      expect(after.display_name).toBe("Updated Name");
      expect(after.yaml_checksum).not.toBe(before.yaml_checksum);
    });

    it("throws when updating a non-existent expert", async () => {
      await expect(lib.update("missing", { displayName: "x" })).rejects.toThrow(/not found/i);
    });
  });

  describe("delete()", () => {
    it("removes YAML file and DB row", async () => {
      await lib.create(makeDef());
      const result = await lib.delete("cto", { force: false });
      expect(result.affectedPanels).toEqual([]);
      const yamlPath = path.join(dataHome, "experts", "cto.yaml");
      await expect(fs.access(yamlPath)).rejects.toThrow();
      expect(await lib.get("cto")).toBeNull();
    });

    it("without force, throws when expert belongs to panels (returns affected list in error)", async () => {
      await lib.create(makeDef());
      const now = new Date().toISOString();
      await db
        .insertInto("panel_library")
        .values({
          name: "arch",
          description: null,
          yaml_path: "/tmp/x.yaml",
          yaml_checksum: "x",
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto("panel_members")
        .values({ panel_name: "arch", expert_slug: "cto", position: 0, created_at: now })
        .execute();

      await expect(lib.delete("cto", { force: false })).rejects.toThrow(/arch/);

      const yamlPath = path.join(dataHome, "experts", "cto.yaml");
      await expect(fs.access(yamlPath)).resolves.toBeUndefined();
    });

    it("with force, deletes even when expert is in panels", async () => {
      await lib.create(makeDef());
      const now = new Date().toISOString();
      await db
        .insertInto("panel_library")
        .values({
          name: "arch",
          description: null,
          yaml_path: "/tmp/x.yaml",
          yaml_checksum: "x",
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto("panel_members")
        .values({ panel_name: "arch", expert_slug: "cto", position: 0, created_at: now })
        .execute();

      const result = await lib.delete("cto", { force: true });
      expect([...result.affectedPanels].sort()).toEqual(["arch"]);
      expect(await lib.get("cto")).toBeNull();
    });

    it("throws when deleting a non-existent expert", async () => {
      await expect(lib.delete("missing", { force: false })).rejects.toThrow(/not found/i);
    });
  });

  describe("panelsFor()", () => {
    it("returns panel names containing the expert", async () => {
      await lib.create(makeDef());
      const now = new Date().toISOString();
      await db
        .insertInto("panel_library")
        .values({
          name: "arch",
          description: null,
          yaml_path: "/tmp/x.yaml",
          yaml_checksum: "x",
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto("panel_members")
        .values({ panel_name: "arch", expert_slug: "cto", position: 0, created_at: now })
        .execute();
      const panels = await lib.panelsFor("cto");
      expect([...panels]).toEqual(["arch"]);
    });

    it("returns empty array for an expert not in any panel", async () => {
      await lib.create(makeDef());
      const panels = await lib.panelsFor("cto");
      expect(panels).toEqual([]);
    });
  });

  describe("atomicity / rollback", () => {
    it("rolls back the DB row when YAML write fails on create()", async () => {
      // Pre-create a *directory* where the YAML file would live so writeFile
      // fails with EISDIR — exercises the compensating DB delete on create.
      const yamlPath = path.join(dataHome, "experts", "cto.yaml");
      await fs.mkdir(yamlPath, { recursive: true });
      await expect(lib.create(makeDef())).rejects.toThrow();
      const row = await db
        .selectFrom("expert_library")
        .selectAll()
        .where("slug", "=", "cto")
        .executeTakeFirst();
      expect(row).toBeUndefined();
    });

    it("surfaces AggregateError when both metadata persist and YAML cleanup fail on create()", async () => {
      const yamlPath = path.join(dataHome, "experts", "cto.yaml");
      const fsSync = await import("node:fs");

      // Reach into the library's internal repo (TS private is compile-time
      // only) so we can force the DB upsert failure after the YAML has been
      // claimed, then replace the YAML file with a directory so cleanup fails.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const repo = (lib as any).repo;
      const createSpy = vi.spyOn(repo, "create").mockImplementationOnce(async () => {
        await fs.unlink(yamlPath);
        fsSync.mkdirSync(yamlPath);
        throw new Error("metadata write failed");
      });

      const err = await lib.create(makeDef()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).message).toMatch(/storage may be inconsistent/i);
      expect((err as AggregateError).errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: "metadata write failed" }),
          expect.objectContaining({ code: expect.stringMatching(/EPERM|EISDIR/) }),
        ]),
      );
      createSpy.mockRestore();
    });

    it("restores prior YAML when DB update fails on update()", async () => {
      await lib.create(makeDef());
      const yamlPath = path.join(dataHome, "experts", "cto.yaml");
      const before = await fs.readFile(yamlPath, "utf-8");

      const spy = vi.spyOn(db, "updateTable").mockImplementationOnce(() => {
        throw new Error("db unavailable");
      });
      await expect(lib.update("cto", { displayName: "x" })).rejects.toThrow(/db unavailable/);
      const after = await fs.readFile(yamlPath, "utf-8");
      expect(after).toBe(before);
      spy.mockRestore();
    });

    it("surfaces AggregateError when both DB update and YAML restore fail on update()", async () => {
      await lib.create(makeDef());
      const yamlPath = path.join(dataHome, "experts", "cto.yaml");
      const fsSync = await import("node:fs");

      // When the DB update fires, swap the YAML file for a directory so the
      // subsequent restore writeFile fails (EISDIR / EPERM). Use sync fs so
      // the swap completes before the spy throws.
      const dbSpy = vi.spyOn(db, "updateTable").mockImplementationOnce(() => {
        fsSync.rmSync(yamlPath, { force: true });
        fsSync.mkdirSync(yamlPath);
        throw new Error("db unavailable");
      });

      const err = await lib.update("cto", { displayName: "x" }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).message).toMatch(/storage may be inconsistent/i);
      expect((err as AggregateError).errors.length).toBeGreaterThanOrEqual(2);
      dbSpy.mockRestore();
    });

    it("preserves expert + panel memberships when fs.unlink fails on delete()", async () => {
      await lib.create(makeDef());
      const now = new Date().toISOString();
      await db
        .insertInto("panel_library")
        .values({
          name: "arch",
          description: null,
          yaml_path: "/tmp/x.yaml",
          yaml_checksum: "x",
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto("panel_members")
        .values({ panel_name: "arch", expert_slug: "cto", position: 0, created_at: now })
        .execute();

      // Replace the YAML file with a directory so fs.unlink fails (EISDIR
      // / EPERM on most platforms). The transactional delete must roll
      // back the expert row AND the cascade-deleted panel_members row.
      const yamlPath = path.join(dataHome, "experts", "cto.yaml");
      await fs.unlink(yamlPath);
      await fs.mkdir(yamlPath);

      await expect(lib.delete("cto", { force: true })).rejects.toThrow();

      const expert = await db
        .selectFrom("expert_library")
        .selectAll()
        .where("slug", "=", "cto")
        .executeTakeFirst();
      expect(expert).toBeDefined();
      const members = await db
        .selectFrom("panel_members")
        .selectAll()
        .where("expert_slug", "=", "cto")
        .execute();
      expect(members).toHaveLength(1);
    });

    it("surfaces AggregateError when both unlink and rollback fail on delete()", async () => {
      await lib.create(makeDef());
      const yamlPath = path.join(dataHome, "experts", "cto.yaml");
      await fs.unlink(yamlPath);
      await fs.mkdir(yamlPath); // makes fs.unlink fail with EISDIR/EPERM

      // Force the rollback insert to fail too — an AggregateError should
      // surface BOTH errors so callers know storage is inconsistent.
      const spy = vi.spyOn(db, "insertInto").mockImplementationOnce(() => {
        throw new Error("rollback insert failed");
      });

      const err = await lib.delete("cto", { force: true }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).message).toMatch(/storage may be inconsistent/i);
      expect((err as AggregateError).errors.length).toBeGreaterThanOrEqual(2);
      spy.mockRestore();
    });
  });

  describe("resolvePanel()", () => {
    it("resolves found slugs and reports missing ones", async () => {
      await lib.create(makeDef({ slug: "cto" }));
      await lib.create(makeDef({ slug: "pm", displayName: "PM" }));
      const result = await lib.resolvePanel(["cto", "pm", "ghost"]);
      expect(result.resolved.map((e) => e.slug).sort()).toEqual(["cto", "pm"]);
      expect([...result.missing]).toEqual(["ghost"]);
    });

    it("handles an empty input list", async () => {
      const result = await lib.resolvePanel([]);
      expect(result.resolved).toEqual([]);
      expect(result.missing).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // #562: parseYaml wraps schema errors with file path + slug context.
  // ─────────────────────────────────────────────────────────────────────
  describe("get() schema-error context (#562)", () => {
    it("wraps Zod parse failure with the file path and the raw YAML slug", async () => {
      // Seed a DB row whose yaml_path points at an on-disk YAML file
      // that fails ExpertDefinitionSchema validation (missing required
      // `role`, `expertise`, `epistemicStance`). The library's `get()`
      // calls the private `parseYaml(content, yamlPath)` wrapper, so
      // the thrown error must mention BOTH the file path and the slug.
      const yamlPath = path.join(dataHome, "experts", "broken.yaml");
      await fs.mkdir(path.dirname(yamlPath), { recursive: true });
      await fs.writeFile(
        yamlPath,
        // Valid YAML, but missing required ExpertDefinition fields.
        "slug: broken\nkind: generic\ndisplayName: Broken\n",
        "utf-8",
      );
      const repo = new ExpertLibraryRepository(db);
      await repo.create({
        slug: "broken",
        kind: "generic",
        displayName: "Broken",
        yamlPath,
        yamlChecksum: "x",
      });

      let caught: unknown = null;
      try {
        await lib.get("broken");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      // The wrapper must include the file path so users can locate
      // which YAML failed validation (the bare Zod error does not).
      expect(message).toContain(yamlPath);
      // The wrapper must also surface the slug from the raw YAML.
      expect(message).toContain("broken");
      // And explicitly name itself as a schema validation failure.
      expect(message).toMatch(/schema validation failed/i);
    });

    it("create() wraps schema validation errors with the slug", async () => {
      // Bypass the assertValidSlug guard with a valid slug, but
      // provide a definition that fails ExpertDefinitionSchema (the
      // schema rejects an invalid `kind`). The error must mention the
      // slug so users see which expert failed.
      const bad = {
        slug: "valid-slug",
        kind: "not-a-real-kind",
        displayName: "X",
        role: "X",
        expertise: { weightedEvidence: ["x"], referenceCases: [], notExpertIn: [] },
        epistemicStance: "x",
      } as unknown as ExpertDefinition;
      let caught: unknown = null;
      try {
        await lib.create(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain("valid-slug");
      expect(message).toMatch(/validation failed/i);
    });
  });
});
