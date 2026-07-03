/**
 * Tests for migration 002 — the expert_documents.status CHECK constraint (#340).
 *
 * Requirement (#340): expert_documents.status must be constrained to the
 * DocumentStatus union ('pending','processed','failed','removed') at the
 * database level, for both brand-new databases (fresh schema) and databases
 * created before this change (via a gated table-rebuild migration).
 *
 * RED at the test commit: migration 002 does not exist yet, so:
 *   - schema_version stops at [1] (not [1, 2]);
 *   - expert_documents.status has no CHECK, so invalid values are accepted.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { sql } from "kysely";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";

const VALID_STATUSES = ["pending", "processed", "failed", "removed"] as const;

async function cleanupDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best effort */
  }
}

async function seedExpertLibrary(db: CouncilDatabase, slug = "ceo"): Promise<void> {
  await db
    .insertInto("expert_library")
    .values({
      slug,
      kind: "persona",
      display_name: "Test Persona",
      yaml_path: `/tmp/Council/experts/${slug}.yaml`,
      yaml_checksum: "y1",
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
    })
    .execute();
}

/**
 * Insert an expert_documents row with an arbitrary `status` string. Typed as
 * `string` (not DocumentStatus) on purpose: the point is to prove the DATABASE
 * rejects out-of-set values regardless of the TypeScript-level narrowing.
 */
async function insertStatus(
  db: CouncilDatabase,
  id: string,
  status: string,
  slug = "ceo",
): Promise<void> {
  await db
    .insertInto("expert_documents")
    .values({
      id,
      expert_slug: slug,
      file_path: `/p/${id}.md`,
      filename: `${id}.md`,
      checksum: "c",
      size_bytes: 1,
      word_count: 1,
      status,
      processed_at: null,
      created_at: "2025-01-01T00:00:00.000Z",
    })
    .execute();
}

async function expertDocumentsTableSql(db: CouncilDatabase): Promise<string> {
  const res = await sql<{ sql: string | null }>`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'expert_documents'
  `.execute(db);
  return res.rows[0]?.sql ?? "";
}

async function hasSlugIndex(db: CouncilDatabase): Promise<boolean> {
  const res = await sql<{ name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_expert_documents_slug'
  `.execute(db);
  return res.rows.length === 1;
}

/**
 * Build a "legacy" database that predates migration 002: schema_version = 1,
 * an expert_library parent row, and an expert_documents table WITHOUT the
 * status CHECK — exactly the shape a database created before #340 would have.
 * Seeds one expert_documents row per supplied status so the upgrade path can
 * be proven to preserve existing data.
 */
function seedLegacyDatabase(
  dbPath: string,
  rows: readonly { readonly id: string; readonly status: string }[],
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
    );
    db.exec(`CREATE TABLE expert_library (
      slug          TEXT PRIMARY KEY,
      kind          TEXT NOT NULL DEFAULT 'generic',
      display_name  TEXT NOT NULL,
      yaml_path     TEXT NOT NULL,
      yaml_checksum TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );`);
    // Pre-#340 expert_documents schema: NO CHECK on status.
    db.exec(`CREATE TABLE expert_documents (
      id            TEXT PRIMARY KEY,
      expert_slug   TEXT NOT NULL REFERENCES expert_library(slug) ON DELETE CASCADE,
      file_path     TEXT NOT NULL,
      filename      TEXT NOT NULL,
      checksum      TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL,
      word_count    INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      processed_at  TEXT,
      created_at    TEXT NOT NULL,
      UNIQUE (expert_slug, file_path)
    );`);
    db.exec("CREATE INDEX idx_expert_documents_slug ON expert_documents (expert_slug, status);");
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (1, ?);").run(
      "2025-01-01T00:00:00.000Z",
    );
    db.prepare(
      "INSERT INTO expert_library (slug, kind, display_name, yaml_path, yaml_checksum, created_at, updated_at) VALUES ('ceo', 'persona', 'CEO', '/p/ceo.yaml', 'y1', ?, ?);",
    ).run("2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
    for (const row of rows) {
      db.prepare(
        "INSERT INTO expert_documents (id, expert_slug, file_path, filename, checksum, size_bytes, word_count, status, processed_at, created_at) VALUES (?, 'ceo', ?, ?, 'c', 1, 1, ?, NULL, '2025-01-01T00:00:00.000Z');",
      ).run(row.id, `/p/${row.id}.md`, `${row.id}.md`, row.status);
    }
  } finally {
    db.close();
  }
}

describe("expert_documents.status CHECK constraint (migration 002, #340)", () => {
  describe("fresh database", () => {
    let db: CouncilDatabase;

    beforeEach(async () => {
      db = await createDatabase(":memory:");
      await seedExpertLibrary(db);
    });

    afterEach(async () => {
      await db.destroy();
    });

    it("advances schema_version to [1, 2]", async () => {
      const versions = (
        await db.selectFrom("schema_version").select("version").orderBy("version").execute()
      ).map((r) => r.version);
      expect(versions).toEqual([1, 2]);
    });

    it("defines a CHECK constraint on expert_documents.status", async () => {
      const tableSql = await expertDocumentsTableSql(db);
      expect(tableSql).toMatch(/CHECK\s*\(\s*status\s+IN\s*\(/i);
    });

    it("keeps the idx_expert_documents_slug index after the rebuild", async () => {
      expect(await hasSlugIndex(db)).toBe(true);
    });

    it.each([...VALID_STATUSES])("accepts the valid status %s", async (status) => {
      await expect(insertStatus(db, `ok-${status}`, status)).resolves.not.toThrow();
    });

    it("rejects an out-of-set status on INSERT", async () => {
      await expect(insertStatus(db, "bad-insert", "bogus")).rejects.toThrow();
    });

    it("rejects an out-of-set status on UPDATE", async () => {
      await insertStatus(db, "u1", "pending");
      await expect(
        db
          .updateTable("expert_documents")
          .set({ status: "not-a-status" })
          .where("id", "=", "u1")
          .execute(),
      ).rejects.toThrow();
    });
  });

  describe("existing database created before migration 002", () => {
    let testHome: string;
    let dbPath: string;

    beforeEach(async () => {
      testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-340-"));
      dbPath = path.join(testHome, "council.db");
    });

    afterEach(async () => {
      await cleanupDir(testHome);
    });

    it("upgrades cleanly: preserves every seeded row, adds the CHECK, advances schema_version", async () => {
      seedLegacyDatabase(
        dbPath,
        VALID_STATUSES.map((status, i) => ({ id: `d${i}`, status })),
      );

      const db = await createDatabase(dbPath);
      try {
        const versions = (
          await db.selectFrom("schema_version").select("version").orderBy("version").execute()
        ).map((r) => r.version);
        expect(versions).toEqual([1, 2]);

        // All pre-existing rows survive the table rebuild, values intact.
        // Assert the FULL seeded row (every column), not just id+status, so a
        // regression that dropped or mutated any column during the rebuild
        // (checksum, size_bytes, word_count, file_path, filename, processed_at,
        // created_at) is caught.
        const docs = await db.selectFrom("expert_documents").selectAll().orderBy("id").execute();
        expect(docs).toEqual(
          VALID_STATUSES.map((status, i) => ({
            id: `d${i}`,
            expert_slug: "ceo",
            file_path: `/p/d${i}.md`,
            filename: `d${i}.md`,
            checksum: "c",
            size_bytes: 1,
            word_count: 1,
            status,
            processed_at: null,
            created_at: "2025-01-01T00:00:00.000Z",
          })),
        );

        // The rebuilt table now enforces the CHECK and kept its lookup index.
        expect(await expertDocumentsTableSql(db)).toMatch(/CHECK\s*\(\s*status\s+IN\s*\(/i);
        expect(await hasSlugIndex(db)).toBe(true);
        await expect(insertStatus(db, "bad-after-upgrade", "bogus")).rejects.toThrow();
      } finally {
        await db.destroy();
      }
    }, 30_000);

    it("is idempotent: re-opening the upgraded database does not re-run migration 002", async () => {
      seedLegacyDatabase(dbPath, [{ id: "d0", status: "pending" }]);

      const first = await createDatabase(dbPath);
      await first.destroy();
      const second = await createDatabase(dbPath);
      try {
        const versions = (
          await second.selectFrom("schema_version").select("version").execute()
        ).map((r) => r.version);
        expect(versions.filter((v) => v === 2)).toHaveLength(1);
        const count = await second
          .selectFrom("expert_documents")
          .select((eb) => eb.fn.countAll<number>().as("c"))
          .executeTakeFirstOrThrow();
        expect(Number(count.c)).toBe(1);
      } finally {
        await second.destroy();
      }
    }, 30_000);

    it("fails loud and rolls back when a pre-existing row has an out-of-set status", async () => {
      // A database created under the OLD, string-typed (no-CHECK) schema could
      // hold an out-of-set status that migration 002's CHECK forbids. The
      // rebuild copy must FAIL and roll the whole migration back rather than
      // silently coercing or dropping the offending row.
      seedLegacyDatabase(dbPath, [
        { id: "d0", status: "pending" },
        { id: "bad", status: "weird" },
      ]);

      await expect(createDatabase(dbPath)).rejects.toThrow();

      // Reopen with a FRESH raw connection: the rollback must have left the DB
      // exactly as it was pre-002 — schema_version still [1], the legacy table
      // shape (no CHECK), and every original row present with its status
      // unchanged. Nothing dropped, nothing mutated.
      const raw = new DatabaseSync(dbPath);
      try {
        const versions = (
          raw.prepare("SELECT version FROM schema_version ORDER BY version").all() as {
            readonly version: number;
          }[]
        ).map((r) => r.version);
        expect(versions).toEqual([1]);

        const tableSql = String(
          (
            raw
              .prepare(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'expert_documents'",
              )
              .get() as { readonly sql: string }
          ).sql,
        );
        expect(tableSql).not.toMatch(/CHECK\s*\(\s*status\s+IN/i);

        const docs = raw.prepare("SELECT id, status FROM expert_documents ORDER BY id").all() as {
          readonly id: string;
          readonly status: string;
        }[];
        expect(docs).toEqual([
          { id: "bad", status: "weird" },
          { id: "d0", status: "pending" },
        ]);
      } finally {
        raw.close();
      }
    }, 30_000);
  });
});
