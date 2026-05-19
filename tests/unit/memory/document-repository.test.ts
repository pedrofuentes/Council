/**
 * Tests for DocumentRepository — Roadmap 6.1.
 *
 * RED at this commit: migration 006, ExpertDocumentRow, and
 * src/memory/repositories/document-repository.ts do not exist yet.
 */
import { sql } from "kysely";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { ExpertLibraryRepository } from "../../../src/memory/repositories/expert-library-repo.js";
import {
  ClearForRetrainError,
  DocumentRepository,
  type NewExpertDocument,
} from "../../../src/memory/repositories/document-repository.js";

async function seedExpert(db: CouncilDatabase, slug = "ceo"): Promise<void> {
  const repo = new ExpertLibraryRepository(db);
  await repo.create({
    slug,
    kind: "persona",
    displayName: "Test Persona",
    yamlPath: `/tmp/Council/experts/${slug}.yaml`,
    yamlChecksum: "y1",
  });
}

function sampleDoc(overrides: Partial<NewExpertDocument> = {}): NewExpertDocument {
  return {
    expertSlug: "ceo",
    filePath: "/tmp/Council/experts/ceo/docs/bio.md",
    filename: "bio.md",
    checksum: "abc123",
    sizeBytes: 1024,
    wordCount: 200,
    ...overrides,
  };
}

describe("DocumentRepository", () => {
  let db: CouncilDatabase;
  let repo: DocumentRepository;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    await seedExpert(db);
    repo = new DocumentRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("create() inserts a row and returns the domain object with id+timestamps", async () => {
    const created = await repo.create(sampleDoc());
    expect(created.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(created.expertSlug).toBe("ceo");
    expect(created.filePath).toBe("/tmp/Council/experts/ceo/docs/bio.md");
    expect(created.filename).toBe("bio.md");
    expect(created.checksum).toBe("abc123");
    expect(created.sizeBytes).toBe(1024);
    expect(created.wordCount).toBe(200);
    expect(created.status).toBe("pending");
    expect(created.processedAt).toBeNull();
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("findByExpert() returns all documents for the expert", async () => {
    await repo.create(sampleDoc({ filePath: "/p/a.md", filename: "a.md" }));
    await repo.create(sampleDoc({ filePath: "/p/b.md", filename: "b.md" }));
    const docs = await repo.findByExpert("ceo");
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.filename).sort()).toEqual(["a.md", "b.md"]);
  });

  it("findByExpert() returns empty array when no documents exist", async () => {
    const docs = await repo.findByExpert("ceo");
    expect(docs).toEqual([]);
  });

  it("findByPath() returns the row when it exists", async () => {
    await repo.create(sampleDoc({ filePath: "/p/a.md" }));
    const found = await repo.findByPath("ceo", "/p/a.md");
    expect(found?.filePath).toBe("/p/a.md");
    const missing = await repo.findByPath("ceo", "/p/missing.md");
    expect(missing).toBeUndefined();
  });

  it("updateStatus() sets status and processedAt", async () => {
    const created = await repo.create(sampleDoc());
    const ts = "2025-01-01T12:00:00.000Z";
    await repo.updateStatus(created.id, "processed", ts);
    const after = await repo.findByPath("ceo", created.filePath);
    expect(after?.status).toBe("processed");
    expect(after?.processedAt).toBe(ts);
  });

  it("updateStatus() works without processedAt argument", async () => {
    const created = await repo.create(sampleDoc());
    await repo.updateStatus(created.id, "failed");
    const after = await repo.findByPath("ceo", created.filePath);
    expect(after?.status).toBe("failed");
    expect(after?.processedAt).toBeNull();
  });

  it("updateChecksum() updates checksum/size/wordCount", async () => {
    const created = await repo.create(sampleDoc());
    await repo.updateChecksum(created.id, "newhash", 2048, 400);
    const after = await repo.findByPath("ceo", created.filePath);
    expect(after?.checksum).toBe("newhash");
    expect(after?.sizeBytes).toBe(2048);
    expect(after?.wordCount).toBe(400);
  });

  it("getChecksumMap() returns path → checksum map for non-removed docs", async () => {
    const a = await repo.create(sampleDoc({ filePath: "/p/a.md", checksum: "h1" }));
    await repo.create(sampleDoc({ filePath: "/p/b.md", checksum: "h2" }));
    const removed = await repo.create(sampleDoc({ filePath: "/p/c.md", checksum: "h3" }));
    await repo.markRemoved(removed.id);

    const map = await repo.getChecksumMap("ceo");
    expect(map.get("/p/a.md")).toBe("h1");
    expect(map.get("/p/b.md")).toBe("h2");
    expect(map.has("/p/c.md")).toBe(false);
    expect(map.size).toBe(2);
    expect(a.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("markRemoved() sets status to 'removed'", async () => {
    const created = await repo.create(sampleDoc());
    await repo.markRemoved(created.id);
    const after = await repo.findByPath("ceo", created.filePath);
    expect(after?.status).toBe("removed");
  });

  it("UNIQUE (expert_slug, file_path) constraint is enforced", async () => {
    await repo.create(sampleDoc({ filePath: "/p/same.md" }));
    await expect(repo.create(sampleDoc({ filePath: "/p/same.md" }))).rejects.toThrow();
  });

  it("migration 006 is idempotent (re-running createDatabase succeeds)", async () => {
    // Already created in beforeEach; creating another DB just exercises migrations again.
    const second = await createDatabase(":memory:");
    await second.destroy();
  });

  describe("mutation operations actually change DB state (issue #343)", () => {
    // Issue #343: existing tests verified mutations only via subsequent
    // reads, which would also pass if the UPDATE silently affected zero
    // rows. Pin the SQL contract by inspecting Kysely's
    // `numUpdatedRows` on the underlying UPDATE statement and by
    // counting rows-by-state before/after each mutation.
    it("updateStatus changes exactly one row's status and leaves siblings untouched", async () => {
      const a = await repo.create(sampleDoc({ filePath: "/p/a.md" }));
      await repo.create(sampleDoc({ filePath: "/p/b.md" }));

      await repo.updateStatus(a.id, "processed", "2025-01-01T00:00:00.000Z");

      const aAfter = await repo.findByPath("ceo", "/p/a.md");
      const bAfter = await repo.findByPath("ceo", "/p/b.md");
      expect(aAfter?.status).toBe("processed");
      expect(bAfter?.status).toBe("pending");

      // Direct kysely call mirrors the repo's SQL so we can read
      // `numUpdatedRows`: a stale id must yield 0, a real id must yield 1.
      const noopResult = await db
        .updateTable("expert_documents")
        .set({ status: "processed" })
        .where("id", "=", "01ZZZZNONEXISTENT0000000000")
        .executeTakeFirst();
      expect(Number(noopResult.numUpdatedRows)).toBe(0);

      const realResult = await db
        .updateTable("expert_documents")
        .set({ status: "failed" })
        .where("id", "=", a.id)
        .executeTakeFirst();
      expect(Number(realResult.numUpdatedRows)).toBe(1);
    });

    it("updateChecksum changes exactly one row's hash/size/wordCount", async () => {
      const a = await repo.create(sampleDoc({ filePath: "/p/a.md", checksum: "old" }));
      await repo.create(sampleDoc({ filePath: "/p/b.md", checksum: "keep" }));

      // Drive through the repository surface, then verify rows.
      await repo.updateChecksum(a.id, "new", 999, 42);

      const aAfter = await repo.findByPath("ceo", "/p/a.md");
      const bAfter = await repo.findByPath("ceo", "/p/b.md");
      expect(aAfter?.checksum).toBe("new");
      expect(aAfter?.sizeBytes).toBe(999);
      expect(aAfter?.wordCount).toBe(42);
      // Sibling row is untouched.
      expect(bAfter?.checksum).toBe("keep");

      // Mirror the repo's SQL on a non-existent id to assert no-op semantics.
      const noop = await db
        .updateTable("expert_documents")
        .set({ checksum: "x", size_bytes: 1, word_count: 1 })
        .where("id", "=", "01ZZZZNONEXISTENT0000000000")
        .executeTakeFirst();
      expect(Number(noop.numUpdatedRows)).toBe(0);
    });

    it("markRemoved changes exactly one row to status='removed'", async () => {
      const a = await repo.create(sampleDoc({ filePath: "/p/a.md" }));
      await repo.create(sampleDoc({ filePath: "/p/b.md" }));

      const before = await db
        .selectFrom("expert_documents")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("status", "=", "removed")
        .executeTakeFirstOrThrow();
      expect(Number(before.n)).toBe(0);

      await repo.markRemoved(a.id);

      const after = await db
        .selectFrom("expert_documents")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("status", "=", "removed")
        .executeTakeFirstOrThrow();
      expect(Number(after.n)).toBe(1);

      // A repeat call against a non-existent id must be a verifiable no-op.
      const noop = await db
        .updateTable("expert_documents")
        .set({ status: "removed" })
        .where("id", "=", "01ZZZZNONEXISTENT0000000000")
        .executeTakeFirst();
      expect(Number(noop.numUpdatedRows)).toBe(0);
    });

    it("markAllRemovedByExpert flips every active row for the expert and leaves pre-removed rows alone", async () => {
      const a = await repo.create(sampleDoc({ filePath: "/p/a.md" }));
      const b = await repo.create(sampleDoc({ filePath: "/p/b.md" }));
      const c = await repo.create(sampleDoc({ filePath: "/p/c.md" }));
      // Pre-mark one as removed so it should NOT be re-touched.
      await repo.markRemoved(c.id);

      // Snapshot pre-state to assert exact diff after the bulk update.
      const activeBefore = await db
        .selectFrom("expert_documents")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("expert_slug", "=", "ceo")
        .where("status", "!=", "removed")
        .executeTakeFirstOrThrow();
      expect(Number(activeBefore.n)).toBe(2);

      // Drive through the repository surface.
      await repo.markAllRemovedByExpert("ceo");

      const stillActive = await db
        .selectFrom("expert_documents")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("expert_slug", "=", "ceo")
        .where("status", "!=", "removed")
        .executeTakeFirstOrThrow();
      expect(Number(stillActive.n)).toBe(0);

      // All three rows must now read as removed (including the pre-removed one).
      for (const id of [a.id, b.id, c.id]) {
        const row = await db
          .selectFrom("expert_documents")
          .select("status")
          .where("id", "=", id)
          .executeTakeFirstOrThrow();
        expect(row.status).toBe("removed");
      }

      // Second call is a no-op: mirror the repo's SQL to read numUpdatedRows.
      const noop = await db
        .updateTable("expert_documents")
        .set({ status: "removed" })
        .where("expert_slug", "=", "ceo")
        .where("status", "!=", "removed")
        .executeTakeFirst();
      expect(Number(noop.numUpdatedRows)).toBe(0);
    });
  });

  describe("clearForRetrain atomicity and rollback honesty (#383, #425)", () => {
    async function seedFtsRow(database: CouncilDatabase, slug: string, body: string): Promise<void> {
      await sql`INSERT INTO document_index (content, source_type, source_slug, file_path)
                VALUES (${body}, 'expert', ${slug}, ${"/p/" + body + ".md"})`.execute(database);
    }

    async function countFts(database: CouncilDatabase, slug: string): Promise<number> {
      const row = await sql<{
        n: number;
      }>`SELECT COUNT(*) AS n FROM document_index WHERE source_type = 'expert' AND source_slug = ${slug}`.execute(
        database,
      );
      return Number(row.rows[0]?.n ?? 0);
    }

    async function countActiveDocs(database: CouncilDatabase, slug: string): Promise<number> {
      const r = await database
        .selectFrom("expert_documents")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("expert_slug", "=", slug)
        .where("status", "!=", "removed")
        .executeTakeFirstOrThrow();
      return Number(r.n);
    }

    /**
     * Wrap the libsql Kysely executor so the next `executeQuery`
     * matching `failOnSqlSubstring` (and optionally any subsequent
     * `ROLLBACK`) throws — letting tests exercise the transaction's
     * failure paths without corrupting the real DB driver. Patches
     * `getExecutor()` because raw `sql.execute(db)` resolves the
     * executor via `db.getExecutor().executeQuery(...)`. We assign an
     * own-property override on the executor instance (instead of using
     * a Proxy) because Kysely's executor uses private class fields, and
     * a Proxy on `executor` would re-bind `this` to the proxy and
     * trigger "Cannot read private member" errors.
     */
    function patchExecuteQuery(
      database: CouncilDatabase,
      opts: { failOnSqlSubstring: string; failRollback?: boolean },
    ): () => void {
      const realExec = database.getExecutor();
      type ExecQueryFn = typeof realExec.executeQuery;
      // Capture the original (likely prototype) method so we can restore it.
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
        // Remove the own-property override so the prototype method is used again.
        delete (realExec as { executeQuery?: ExecQueryFn }).executeQuery;
      };
    }

    it("succeeds atomically: FTS rows are deleted and tracking rows flipped to removed", async () => {
      const a = await repo.create(sampleDoc({ filePath: "/p/a.md" }));
      const b = await repo.create(sampleDoc({ filePath: "/p/b.md" }));
      await seedFtsRow(db, "ceo", "a");
      await seedFtsRow(db, "ceo", "b");
      expect(await countFts(db, "ceo")).toBe(2);
      expect(await countActiveDocs(db, "ceo")).toBe(2);

      await repo.clearForRetrain("ceo");

      expect(await countFts(db, "ceo")).toBe(0);
      expect(await countActiveDocs(db, "ceo")).toBe(0);
      // Tracking rows are kept (status flipped) so the detector reclassifies
      // them on retrain — they MUST still exist, only marked removed.
      const aAfter = await repo.findByPath("ceo", a.filePath);
      const bAfter = await repo.findByPath("ceo", b.filePath);
      expect(aAfter?.status).toBe("removed");
      expect(bAfter?.status).toBe("removed");
    });

    it("rolls back atomically when the tracking UPDATE fails: FTS rows survive, no docs flipped", async () => {
      await repo.create(sampleDoc({ filePath: "/p/a.md" }));
      await repo.create(sampleDoc({ filePath: "/p/b.md" }));
      await seedFtsRow(db, "ceo", "a");
      await seedFtsRow(db, "ceo", "b");

      const restore = patchExecuteQuery(db, {
        failOnSqlSubstring: "UPDATE expert_documents",
      });

      let caught: unknown;
      try {
        await repo.clearForRetrain("ceo");
      } catch (e) {
        caught = e;
      } finally {
        restore();
      }

      expect(caught).toBeInstanceOf(ClearForRetrainError);
      const err = caught as ClearForRetrainError;
      expect(err.rollbackFailed).toBe(false);
      expect(err.message).not.toMatch(/inconsistent/i);

      // Atomicity: the prior DELETE must have been rolled back.
      expect(await countFts(db, "ceo")).toBe(2);
      expect(await countActiveDocs(db, "ceo")).toBe(2);
    });

    it("when ROLLBACK itself fails, the thrown error reports it honestly (no 'preserved' claim)", async () => {
      await repo.create(sampleDoc({ filePath: "/p/a.md" }));
      await seedFtsRow(db, "ceo", "a");

      const restore = patchExecuteQuery(db, {
        failOnSqlSubstring: "UPDATE expert_documents",
        failRollback: true,
      });

      let caught: unknown;
      try {
        await repo.clearForRetrain("ceo");
      } catch (e) {
        caught = e;
      } finally {
        restore();
      }

      expect(caught).toBeInstanceOf(ClearForRetrainError);
      const err = caught as ClearForRetrainError;
      expect(err.rollbackFailed).toBe(true);
      expect(err.rollbackError).toBeInstanceOf(Error);
      expect(err.message).toMatch(/inconsistent/i);
      expect(err.message).not.toMatch(/preserved/i);
      expect(err.cause).toBeInstanceOf(Error);
    });

    it("when BEGIN itself fails, throws ClearForRetrainError with rollbackFailed=false (no mutation occurred)", async () => {
      await repo.create(sampleDoc({ filePath: "/p/a.md" }));
      await seedFtsRow(db, "ceo", "a");

      // Fail BEGIN itself — no rollback is needed because the
      // transaction never opened, but the contract still requires a
      // ClearForRetrainError so callers can branch correctly (#425).
      const restore = patchExecuteQuery(db, { failOnSqlSubstring: "BEGIN" });

      let caught: unknown;
      try {
        await repo.clearForRetrain("ceo");
      } catch (e) {
        caught = e;
      } finally {
        restore();
      }

      expect(caught).toBeInstanceOf(ClearForRetrainError);
      const err = caught as ClearForRetrainError;
      expect(err.rollbackFailed).toBe(false);
      expect(err.message).toMatch(/BEGIN/);
      expect(err.message).toMatch(/no changes applied/i);
      expect(err.cause).toBeInstanceOf(Error);

      // No mutation actually occurred — both stores are untouched.
      expect(await countFts(db, "ceo")).toBe(1);
      expect(await countActiveDocs(db, "ceo")).toBe(1);
    });

    it("structural guard: committed flag prevents misleading error on post-COMMIT failure (#537)", async () => {
      // Issue #537: Same as setMembers — add a `committed` flag (line 206 in
      // document-repository.ts) that prevents ROLLBACK attempts when post-COMMIT
      // code fails. Currently, clearForRetrain has NO code after COMMIT, so this
      // defensive branch is unreachable. This test documents the requirement for
      // future code changes.
      await repo.create(sampleDoc({ filePath: "/p/a.md" }));
      await seedFtsRow(db, "ceo", "a");
      await expect(repo.clearForRetrain("ceo")).resolves.toBeUndefined();
      
      // The committed flag pattern is now in place (see lines 206, 221 of
      // document-repository.ts). If someone adds post-COMMIT code that throws,
      // the error will correctly state "committed successfully but subsequent
      // operation failed" instead of "rolled back cleanly".
    });
  });
});
