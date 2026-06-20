/**
 * Tests for createDocumentIndexer — Roadmap 6.3 (Content Indexing / RAG).
 *
 * RED at this commit: migration 007, src/core/documents/indexer.ts, and the
 * document_index FTS5 virtual table do not exist yet.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { sql } from "kysely";

import { createDatabase, type CouncilDatabase } from "../../../../src/memory/db.js";
import { createDocumentIndexer } from "../../../../src/core/documents/indexer.js";

async function countRows(db: CouncilDatabase): Promise<number> {
  const result = await sql<{ n: number }>`SELECT count(*) AS n FROM document_index`.execute(db);
  return Number(result.rows[0]?.n ?? 0);
}

async function rowsForPath(
  db: CouncilDatabase,
  filePath: string,
): Promise<readonly { source_type: string; source_slug: string; content: string }[]> {
  const result = await sql<{
    source_type: string;
    source_slug: string;
    content: string;
  }>`SELECT source_type, source_slug, content FROM document_index WHERE file_path = ${filePath}`.execute(
    db,
  );
  return result.rows;
}

describe("createDocumentIndexer", () => {
  let db: CouncilDatabase;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("indexes document content into the FTS5 table", async () => {
    const indexer = createDocumentIndexer(db);
    await indexer.index({
      content: "The product roadmap focuses on document intelligence.",
      sourceType: "expert",
      sourceSlug: "ceo",
      filePath: "/docs/experts/ceo/bio.md",
    });

    const rows = await rowsForPath(db, "/docs/experts/ceo/bio.md");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source_type).toBe("expert");
    expect(rows[0]?.source_slug).toBe("ceo");
    expect(rows[0]?.content).toContain("document intelligence");
  });

  it("re-indexing the same path replaces existing content", async () => {
    const indexer = createDocumentIndexer(db);
    await indexer.index({
      content: "first version of the document",
      sourceType: "expert",
      sourceSlug: "ceo",
      filePath: "/docs/experts/ceo/bio.md",
    });
    await indexer.index({
      content: "second version of the document",
      sourceType: "expert",
      sourceSlug: "ceo",
      filePath: "/docs/experts/ceo/bio.md",
    });

    const rows = await rowsForPath(db, "/docs/experts/ceo/bio.md");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toContain("second version");
    expect(rows[0]?.content).not.toContain("first version");
  });

  it("remove() deletes the entry for a given file path", async () => {
    const indexer = createDocumentIndexer(db);
    await indexer.index({
      content: "alpha",
      sourceType: "expert",
      sourceSlug: "ceo",
      filePath: "/docs/a.md",
    });
    await indexer.index({
      content: "beta",
      sourceType: "expert",
      sourceSlug: "ceo",
      filePath: "/docs/b.md",
    });

    await indexer.remove("/docs/a.md");

    expect(await rowsForPath(db, "/docs/a.md")).toHaveLength(0);
    expect(await rowsForPath(db, "/docs/b.md")).toHaveLength(1);
  });

  it("remove() on a non-existent path is a no-op", async () => {
    const indexer = createDocumentIndexer(db);
    await indexer.index({
      content: "alpha",
      sourceType: "expert",
      sourceSlug: "ceo",
      filePath: "/docs/a.md",
    });

    await expect(indexer.remove("/docs/missing.md")).resolves.toBeUndefined();
    expect(await countRows(db)).toBe(1);
  });

  it("removeAll() clears every entry for a given source", async () => {
    const indexer = createDocumentIndexer(db);
    await indexer.index({
      content: "a1",
      sourceType: "expert",
      sourceSlug: "ceo",
      filePath: "/docs/ceo/a.md",
    });
    await indexer.index({
      content: "a2",
      sourceType: "expert",
      sourceSlug: "ceo",
      filePath: "/docs/ceo/b.md",
    });
    await indexer.index({
      content: "c1",
      sourceType: "expert",
      sourceSlug: "cto",
      filePath: "/docs/cto/a.md",
    });
    await indexer.index({
      content: "p1",
      sourceType: "panel",
      sourceSlug: "exec-team",
      filePath: "/docs/panels/exec/a.md",
    });

    await indexer.removeAll("expert", "ceo");

    expect(await countRows(db)).toBe(2);
    expect(await rowsForPath(db, "/docs/ceo/a.md")).toHaveLength(0);
    expect(await rowsForPath(db, "/docs/cto/a.md")).toHaveLength(1);
    expect(await rowsForPath(db, "/docs/panels/exec/a.md")).toHaveLength(1);
  });

  it("index() is atomic — DELETE+INSERT wrapped in BEGIN/COMMIT (#356)", async () => {
    // Atomicity contract: DELETE and INSERT must run inside a single
    // transaction so a failing INSERT rolls back the DELETE. Verified
    // structurally by recording every compiled SQL statement at the
    // libsql connection layer and asserting BEGIN appears before
    // DELETE FROM document_index and COMMIT appears after INSERT INTO
    // document_index.
    const { NodeSqliteConnection } = await import("../../../../src/memory/node-sqlite-dialect.js");
    const protoAny = NodeSqliteConnection.prototype as unknown as {
      executeQuery: (q: { sql: string }) => Promise<unknown>;
    };
    const orig = protoAny.executeQuery;
    const calls: string[] = [];
    protoAny.executeQuery = async function (
      this: unknown,
      q: { sql: string },
    ) {
      if (typeof q?.sql === "string") calls.push(q.sql);
      return orig.call(this, q);
    };
    try {
      const indexer = createDocumentIndexer(db);
      await indexer.index({
        content: "atomic test content",
        sourceType: "expert",
        sourceSlug: "ceo",
        filePath: "/docs/atomic.md",
      });
    } finally {
      protoAny.executeQuery = orig;
    }
    const beginIdx = calls.findIndex((s) => /^\s*BEGIN\b/i.test(s));
    const deleteIdx = calls.findIndex((s) => /DELETE\s+FROM\s+document_index/i.test(s));
    const insertIdx = calls.findIndex((s) => /INSERT\s+INTO\s+document_index/i.test(s));
    const commitIdx = calls.findIndex((s) => /^\s*COMMIT\b/i.test(s));
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(beginIdx);
    expect(insertIdx).toBeGreaterThan(deleteIdx);
    expect(commitIdx).toBeGreaterThan(insertIdx);
  });

  it("index() issues ROLLBACK when INSERT fails, then propagates error (#426)", async () => {
    // Regression test for the rollback branch (lines 63-70 in indexer.ts).
    // When the INSERT throws, the catch block must issue ROLLBACK so the
    // prior DELETE does not commit orphaned. We verify: (a) ROLLBACK
    // appears in the call log, (b) the original error propagates, (c) any
    // pre-existing row survives.
    const { NodeSqliteConnection } = await import("../../../../src/memory/node-sqlite-dialect.js");
    const protoAny = NodeSqliteConnection.prototype as unknown as {
      executeQuery: (q: { sql: string }) => Promise<unknown>;
    };
    const orig = protoAny.executeQuery;
    const calls: string[] = [];
    let insertCallCount = 0;
    protoAny.executeQuery = async function (
      this: unknown,
      q: { sql: string },
    ) {
      if (typeof q?.sql === "string") calls.push(q.sql);
      // Fail the second INSERT attempt (the one that rewrites) to force rollback.
      if (/INSERT\s+INTO\s+document_index/i.test(q?.sql ?? "")) {
        insertCallCount++;
        if (insertCallCount === 2) {
          throw new Error("simulated INSERT failure");
        }
      }
      return orig.call(this, q);
    };

    const indexer = createDocumentIndexer(db);
    
    try {
      // Pre-populate a row so we can assert it survives the failed transaction.
      await indexer.index({
        content: "original content",
        sourceType: "expert",
        sourceSlug: "ceo",
        filePath: "/docs/orig.md",
      });

      // Attempt to overwrite; the INSERT will fail → rollback.
      await expect(
        indexer.index({
          content: "new content",
          sourceType: "expert",
          sourceSlug: "ceo",
          filePath: "/docs/orig.md",
        }),
      ).rejects.toThrow("simulated INSERT failure");

      // Verify ROLLBACK appeared in the call log.
      const rollbackIdx = calls.findIndex((s) => /^\s*ROLLBACK\b/i.test(s));
      expect(rollbackIdx).toBeGreaterThanOrEqual(0);

      // Verify the original row still exists (DELETE was rolled back).
      const results = await db
        .selectFrom("document_index")
        .selectAll()
        .where("file_path", "=", "/docs/orig.md")
        .execute();
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toBe("original content");
    } finally {
      protoAny.executeQuery = orig;
    }
  });

  it("removeAll() only removes the matching source_type", async () => {
    const indexer = createDocumentIndexer(db);
    await indexer.index({
      content: "expert content",
      sourceType: "expert",
      sourceSlug: "shared",
      filePath: "/docs/expert.md",
    });
    await indexer.index({
      content: "panel content",
      sourceType: "panel",
      sourceSlug: "shared",
      filePath: "/docs/panel.md",
    });

    await indexer.removeAll("panel", "shared");

    expect(await rowsForPath(db, "/docs/expert.md")).toHaveLength(1);
    expect(await rowsForPath(db, "/docs/panel.md")).toHaveLength(0);
  });
});
