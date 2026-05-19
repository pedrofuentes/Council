/**
 * Tests for PanelLibraryRepository — typed CRUD over the panel_library
 * and panel_members tables (migration 004).
 *
 * RED at this commit: src/memory/repositories/panel-library-repo.ts does
 * not yet exist.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import {
  PanelLibraryRepository,
  SetMembersError,
  type NewLibraryPanel,
} from "../../../src/memory/repositories/panel-library-repo.js";
import { ExpertLibraryRepository } from "../../../src/memory/repositories/expert-library-repo.js";

/**
 * Wrap the libsql Kysely executor so the next `executeQuery` matching
 * `failOnSqlSubstring` (and optionally any subsequent `ROLLBACK`) throws.
 * Mirrors the helper in document-repository.test.ts so we can exercise
 * the BEGIN/COMMIT/ROLLBACK paths added for #298 without corrupting the
 * driver. We override `executeQuery` as an own-property on the executor
 * instance because Kysely's executor uses private class fields and a
 * Proxy would re-bind `this` and break private access.
 */
function patchExecuteQuery(
  database: CouncilDatabase,
  opts: { failOnSqlSubstring: string; failRollback?: boolean },
): () => void {
  const realExec = database.getExecutor();
  type ExecQueryFn = typeof realExec.executeQuery;
  const originalExecuteQuery: ExecQueryFn = realExec.executeQuery as ExecQueryFn;
  const wrapped: ExecQueryFn = async function (this: typeof realExec, compiled, queryId) {
    const text = compiled.sql;
    if (text.includes(opts.failOnSqlSubstring)) {
      throw new Error(`simulated failure on: ${opts.failOnSqlSubstring}`);
    }
    if (opts.failRollback === true && /^\s*ROLLBACK\b/i.test(text)) {
      throw new Error("simulated ROLLBACK failure");
    }
    return originalExecuteQuery.call(this, compiled, queryId);
  };
  Object.defineProperty(realExec, "executeQuery", {
    value: wrapped,
    configurable: true,
    writable: true,
  });
  return () => {
    delete (realExec as { executeQuery?: ExecQueryFn }).executeQuery;
  };
}

function samplePanel(name = "arch-review"): NewLibraryPanel {
  return {
    name,
    description: "Multi-perspective architecture review",
    yamlPath: `/tmp/Council/panels/${name}.yaml`,
    yamlChecksum: "checksum-abc",
  };
}

async function seedExpert(db: CouncilDatabase, slug: string): Promise<void> {
  const repo = new ExpertLibraryRepository(db);
  await repo.create({
    slug,
    kind: "generic",
    displayName: `Expert ${slug}`,
    yamlPath: `/tmp/Council/experts/${slug}.yaml`,
    yamlChecksum: "x",
  });
}

describe("PanelLibraryRepository", () => {
  let db: CouncilDatabase;
  let repo: PanelLibraryRepository;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    repo = new PanelLibraryRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("create() inserts a row and returns the domain object with timestamps", async () => {
    const created = await repo.create(samplePanel("arch-review"));
    expect(created.name).toBe("arch-review");
    expect(created.description).toBe("Multi-perspective architecture review");
    expect(created.yamlPath).toContain("arch-review.yaml");
    expect(created.yamlChecksum).toBe("checksum-abc");
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(created.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("create() accepts null description", async () => {
    const created = await repo.create({
      name: "no-desc",
      description: null,
      yamlPath: "/tmp/Council/panels/no-desc.yaml",
      yamlChecksum: "y",
    });
    expect(created.description).toBeNull();
  });

  it("findByName() returns the row when present, undefined otherwise", async () => {
    await repo.create(samplePanel("arch-review"));
    const found = await repo.findByName("arch-review");
    expect(found?.name).toBe("arch-review");
    const missing = await repo.findByName("missing");
    expect(missing).toBeUndefined();
  });

  it("findAll() returns every library panel sorted by name", async () => {
    await repo.create(samplePanel("zeta"));
    await repo.create(samplePanel("alpha"));
    const all = await repo.findAll();
    expect(all.map((p) => p.name)).toEqual(["alpha", "zeta"]);
  });

  it("update() patches columns and refreshes updated_at", async () => {
    const created = await repo.create(samplePanel("arch-review"));
    await new Promise((r) => setTimeout(r, 10));
    await repo.update("arch-review", {
      description: "Updated description",
      yamlChecksum: "new-checksum",
    });
    const after = await repo.findByName("arch-review");
    expect(after?.description).toBe("Updated description");
    expect(after?.yamlChecksum).toBe("new-checksum");
    expect(after?.updatedAt >= created.updatedAt).toBe(true);
  });

  it("delete() removes the row", async () => {
    await repo.create(samplePanel("arch-review"));
    await repo.delete("arch-review");
    expect(await repo.findByName("arch-review")).toBeUndefined();
  });

  it("setMembers() inserts membership rows with positions", async () => {
    await repo.create(samplePanel("arch-review"));
    await seedExpert(db, "cto");
    await seedExpert(db, "staff");

    await repo.setMembers("arch-review", ["cto", "staff"]);
    const members = await repo.getMembers("arch-review");
    expect(members).toEqual(["cto", "staff"]);
  });

  it("setMembers() replaces existing membership rows", async () => {
    await repo.create(samplePanel("arch-review"));
    await seedExpert(db, "cto");
    await seedExpert(db, "staff");
    await seedExpert(db, "pm");

    await repo.setMembers("arch-review", ["cto", "staff"]);
    await repo.setMembers("arch-review", ["pm", "cto"]);
    const members = await repo.getMembers("arch-review");
    expect(members).toEqual(["pm", "cto"]);
  });

  it("getMembers() preserves insertion order via position", async () => {
    await repo.create(samplePanel("arch-review"));
    await seedExpert(db, "a");
    await seedExpert(db, "b");
    await seedExpert(db, "c");

    await repo.setMembers("arch-review", ["c", "a", "b"]);
    const members = await repo.getMembers("arch-review");
    expect(members).toEqual(["c", "a", "b"]);
  });

  it("getMembers() returns empty array for an unknown panel", async () => {
    const members = await repo.getMembers("nonexistent");
    expect(members).toEqual([]);
  });

  it("setMembers() rejects unknown expert slug via FK constraint", async () => {
    await repo.create(samplePanel("arch-review"));
    await expect(repo.setMembers("arch-review", ["does-not-exist"])).rejects.toThrow();
  });

  describe("setMembers atomicity and rollback honesty (#298)", () => {
    it("preserves existing membership when the new insert fails (transaction rolls back cleanly)", async () => {
      await repo.create(samplePanel("arch-review"));
      await seedExpert(db, "cto");
      await seedExpert(db, "staff");
      await repo.setMembers("arch-review", ["cto", "staff"]);

      // Attempt to replace with a list containing an unknown slug — must
      // fail (FK violation) AND leave the prior membership intact.
      let caught: unknown;
      try {
        await repo.setMembers("arch-review", ["cto", "does-not-exist"]);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(SetMembersError);
      const err = caught as SetMembersError;
      expect(err.rollbackFailed).toBe(false);
      expect(err.message).not.toMatch(/inconsistent/i);
      expect(err.cause).toBeInstanceOf(Error);

      const after = await repo.getMembers("arch-review");
      expect(after).toEqual(["cto", "staff"]);
    });

    it("when ROLLBACK itself fails, the thrown error reports it honestly (no 'preserved' claim)", async () => {
      await repo.create(samplePanel("arch-review"));
      await seedExpert(db, "cto");
      await repo.setMembers("arch-review", ["cto"]);

      // Force the INSERT into panel_members to fail, then force ROLLBACK
      // to fail too. We must observe an honest SetMembersError that does
      // NOT claim prior data was preserved.
      const restore = patchExecuteQuery(db, {
        failOnSqlSubstring: 'insert into "panel_members"',
        failRollback: true,
      });

      let caught: unknown;
      try {
        await repo.setMembers("arch-review", ["cto"]);
      } catch (e) {
        caught = e;
      } finally {
        restore();
      }

      expect(caught).toBeInstanceOf(SetMembersError);
      const err = caught as SetMembersError;
      expect(err.rollbackFailed).toBe(true);
      expect(err.rollbackError).toBeInstanceOf(Error);
      expect(err.message).toMatch(/inconsistent/i);
      expect(err.message).not.toMatch(/preserved/i);
      expect(err.cause).toBeInstanceOf(Error);
    });

    it("when BEGIN itself fails, throws SetMembersError with rollbackFailed=false (no mutation occurred)", async () => {
      await repo.create(samplePanel("arch-review"));
      await seedExpert(db, "cto");
      await repo.setMembers("arch-review", ["cto"]);

      const restore = patchExecuteQuery(db, { failOnSqlSubstring: "BEGIN" });

      let caught: unknown;
      try {
        await repo.setMembers("arch-review", ["cto"]);
      } catch (e) {
        caught = e;
      } finally {
        restore();
      }

      expect(caught).toBeInstanceOf(SetMembersError);
      const err = caught as SetMembersError;
      expect(err.rollbackFailed).toBe(false);
      expect(err.message).toMatch(/BEGIN/);
      expect(err.message).toMatch(/no changes applied/i);
      expect(err.cause).toBeInstanceOf(Error);

      // No mutation actually occurred — prior membership is untouched.
      const after = await repo.getMembers("arch-review");
      expect(after).toEqual(["cto"]);
    });

    it("structural guard: post-COMMIT code in setMembers must not mis-translate failures (#537)", async () => {
      // Issue #537 (Sentinel-rejected gaming-test replacement): the
      // catch-block contract is "transaction rolled back cleanly" only
      // when the failure occurred BEFORE COMMIT. Today setMembers has no
      // post-COMMIT code, so the only paths exercisable here are
      // pre-COMMIT failures — verify they produce the contracted error
      // shape (SetMembersError, rollbackFailed=false, no "inconsistent"
      // claim). A code-comment in panel-library-repo.ts documents the
      // pattern future contributors must apply if they add post-COMMIT
      // work; if that guard is forgotten the error message would falsely
      // claim "rolled back cleanly", contradicting committed state.
      await repo.create(samplePanel("arch-review"));
      await seedExpert(db, "cto");
      await repo.setMembers("arch-review", ["cto"]);

      const restore = patchExecuteQuery(db, {
        failOnSqlSubstring: 'insert into "panel_members"',
      });

      let caught: unknown;
      try {
        await repo.setMembers("arch-review", ["cto"]);
      } catch (e) {
        caught = e;
      } finally {
        restore();
      }

      expect(caught).toBeInstanceOf(SetMembersError);
      const err = caught as SetMembersError;
      expect(err.rollbackFailed).toBe(false);
      expect(err.message).toMatch(/rolled back cleanly/i);
      expect(err.message).not.toMatch(/inconsistent/i);
      expect(err.cause).toBeInstanceOf(Error);
      // Atomicity: prior members are still intact.
      const after = await repo.getMembers("arch-review");
      expect(after).toEqual(["cto"]);
    });
  });
});
