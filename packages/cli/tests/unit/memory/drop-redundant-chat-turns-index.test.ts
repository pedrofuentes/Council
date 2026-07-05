/**
 * Tests for migration 003 — dropping the redundant idx_chat_turns_chat_seq
 * index (#320).
 *
 * Requirement (#320): chat_turns declares UNIQUE (chat_id, seq) (migration
 * 001), which SQLite backs with an implicit covering index on (chat_id, seq).
 * The separate explicit `CREATE INDEX idx_chat_turns_chat_seq ON chat_turns
 * (chat_id, seq)` is therefore redundant and must be dropped — for BOTH
 * brand-new databases and databases created before this change (which already
 * recorded schema_version [1, 2] with the explicit index present) — via a
 * gated, additive migration. The UNIQUE constraint (and its implicit index)
 * and all existing chat_turns rows must remain intact afterwards.
 *
 * These tests run on file-backed temp databases (NOT ":memory:") so the
 * schema_version gate and cross-open idempotency are actually exercised — an
 * in-memory database is discarded between opens and never bites the gate.
 *
 * RED before the impl commit: migration 003 does not exist yet, so the
 * explicit index is still present and schema_version stops at [1, 2].
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { sql } from "kysely";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";

const REDUNDANT_INDEX = "idx_chat_turns_chat_seq";
const ISO = "2025-01-01T00:00:00.000Z";

interface IndexListRow {
  readonly name: string;
  readonly unique: number;
  readonly origin: string;
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best effort */
  }
}

/** Rows from `PRAGMA index_list('chat_turns')` (seq, name, unique, origin, partial). */
async function chatTurnsIndexes(db: CouncilDatabase): Promise<readonly IndexListRow[]> {
  const res = await sql<IndexListRow>`PRAGMA index_list('chat_turns')`.execute(db);
  return res.rows;
}

async function hasRedundantIndex(db: CouncilDatabase): Promise<boolean> {
  return (await chatTurnsIndexes(db)).some((r) => r.name === REDUNDANT_INDEX);
}

/**
 * Whether SQLite's implicit UNIQUE-backing index survives. PRAGMA index_list
 * reports auto-created UNIQUE-constraint indexes with origin 'u' and unique 1.
 */
async function hasUniqueAutoIndex(db: CouncilDatabase): Promise<boolean> {
  return (await chatTurnsIndexes(db)).some((r) => r.origin === "u" && Number(r.unique) === 1);
}

async function chatTurnsTableSql(db: CouncilDatabase): Promise<string> {
  const res = await sql<{ sql: string | null }>`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_turns'
  `.execute(db);
  return res.rows[0]?.sql ?? "";
}

async function schemaVersions(db: CouncilDatabase): Promise<readonly number[]> {
  return (await db.selectFrom("schema_version").select("version").orderBy("version").execute()).map(
    (r) => r.version,
  );
}

async function seedChatData(db: CouncilDatabase): Promise<void> {
  await db
    .insertInto("chat_sessions")
    .values({
      id: "cs1",
      target_type: "expert",
      target_slug: "ceo",
      status: "active",
      summary: null,
      summary_through_seq: 0,
      created_at: ISO,
      updated_at: ISO,
    })
    .execute();
  await db
    .insertInto("chat_turns")
    .values([
      {
        id: "ct1",
        chat_id: "cs1",
        seq: 1,
        role: "user",
        expert_slug: null,
        content: "hi",
        is_mention: 0,
        tokens_in: null,
        tokens_out: null,
        created_at: ISO,
      },
      {
        id: "ct2",
        chat_id: "cs1",
        seq: 2,
        role: "expert",
        expert_slug: "ceo",
        content: "hello",
        is_mention: 0,
        tokens_in: 1,
        tokens_out: 2,
        created_at: ISO,
      },
    ])
    .execute();
}

async function insertChatTurn(db: CouncilDatabase, id: string, seq: number): Promise<void> {
  await db
    .insertInto("chat_turns")
    .values({
      id,
      chat_id: "cs1",
      seq,
      role: "user",
      expert_slug: null,
      content: "dup",
      is_mention: 0,
      tokens_in: null,
      tokens_out: null,
      created_at: ISO,
    })
    .execute();
}

/**
 * Build a database that predates migration 003: schema_version = [1, 2], the
 * chat_sessions/chat_turns tables with UNIQUE (chat_id, seq) AND the redundant
 * explicit index present — exactly the shape an install created before #320
 * would have. Seeds one chat_session and two chat_turns so the upgrade path can
 * be proven to preserve existing data.
 */
function seedLegacyChatDatabase(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
    );
    db.exec(`CREATE TABLE chat_sessions (
      id                  TEXT PRIMARY KEY,
      target_type         TEXT NOT NULL,
      target_slug         TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'active',
      summary             TEXT,
      summary_through_seq INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );`);
    db.exec(`CREATE TABLE chat_turns (
      id           TEXT PRIMARY KEY,
      chat_id      TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      seq          INTEGER NOT NULL,
      role         TEXT NOT NULL,
      expert_slug  TEXT,
      content      TEXT NOT NULL,
      is_mention   INTEGER NOT NULL DEFAULT 0,
      tokens_in    INTEGER,
      tokens_out   INTEGER,
      created_at   TEXT NOT NULL,
      UNIQUE (chat_id, seq)
    );`);
    // The redundant explicit index that migration 003 must drop.
    db.exec("CREATE INDEX idx_chat_turns_chat_seq ON chat_turns (chat_id, seq);");
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (1, ?);").run(ISO);
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (2, ?);").run(ISO);
    db.prepare(
      "INSERT INTO chat_sessions (id, target_type, target_slug, status, summary, summary_through_seq, created_at, updated_at) VALUES ('cs1', 'expert', 'ceo', 'active', NULL, 0, ?, ?);",
    ).run(ISO, ISO);
    db.prepare(
      "INSERT INTO chat_turns (id, chat_id, seq, role, expert_slug, content, is_mention, tokens_in, tokens_out, created_at) VALUES ('ct1', 'cs1', 1, 'user', NULL, 'hi', 0, NULL, NULL, ?);",
    ).run(ISO);
    db.prepare(
      "INSERT INTO chat_turns (id, chat_id, seq, role, expert_slug, content, is_mention, tokens_in, tokens_out, created_at) VALUES ('ct2', 'cs1', 2, 'expert', 'ceo', 'hello', 0, 1, 2, ?);",
    ).run(ISO);
  } finally {
    db.close();
  }
}

const EXPECTED_TURNS = [
  {
    id: "ct1",
    chat_id: "cs1",
    seq: 1,
    role: "user",
    expert_slug: null,
    content: "hi",
    is_mention: 0,
    tokens_in: null,
    tokens_out: null,
    created_at: ISO,
  },
  {
    id: "ct2",
    chat_id: "cs1",
    seq: 2,
    role: "expert",
    expert_slug: "ceo",
    content: "hello",
    is_mention: 0,
    tokens_in: 1,
    tokens_out: 2,
    created_at: ISO,
  },
] as const;

describe("redundant chat_turns index drop (migration 003, #320)", () => {
  describe("fresh database", () => {
    let testHome: string;
    let dbPath: string;
    let db: CouncilDatabase;

    beforeEach(async () => {
      testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-320-fresh-"));
      dbPath = path.join(testHome, "council.db");
      db = await createDatabase(dbPath);
    });

    afterEach(async () => {
      await db.destroy();
      await cleanupDir(testHome);
    });

    it("advances schema_version to [1, 2, 3]", async () => {
      expect(await schemaVersions(db)).toEqual([1, 2, 3]);
    });

    it("drops the redundant idx_chat_turns_chat_seq index", async () => {
      expect(await hasRedundantIndex(db)).toBe(false);
    });

    it("keeps the UNIQUE (chat_id, seq) constraint and its implicit index", async () => {
      expect(await chatTurnsTableSql(db)).toMatch(/UNIQUE\s*\(\s*chat_id\s*,\s*seq\s*\)/i);
      expect(await hasUniqueAutoIndex(db)).toBe(true);
    });

    it("preserves inserted chat_turns and still enforces UNIQUE (chat_id, seq)", async () => {
      await seedChatData(db);

      const turns = await db.selectFrom("chat_turns").selectAll().orderBy("seq").execute();
      expect(turns).toEqual([...EXPECTED_TURNS]);

      // The UNIQUE constraint (implicit index) still rejects a duplicate key.
      await expect(insertChatTurn(db, "dup", 1)).rejects.toThrow();
    });
  });

  describe("existing database created before migration 003", () => {
    let testHome: string;
    let dbPath: string;

    beforeEach(async () => {
      testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-320-legacy-"));
      dbPath = path.join(testHome, "council.db");
    });

    afterEach(async () => {
      await cleanupDir(testHome);
    });

    it("drops the index, preserves every row, keeps UNIQUE, and advances schema_version to [1, 2, 3]", async () => {
      seedLegacyChatDatabase(dbPath);

      const db = await createDatabase(dbPath);
      try {
        expect(await schemaVersions(db)).toEqual([1, 2, 3]);
        expect(await hasRedundantIndex(db)).toBe(false);
        expect(await chatTurnsTableSql(db)).toMatch(/UNIQUE\s*\(\s*chat_id\s*,\s*seq\s*\)/i);
        expect(await hasUniqueAutoIndex(db)).toBe(true);

        const turns = await db.selectFrom("chat_turns").selectAll().orderBy("seq").execute();
        expect(turns).toEqual([...EXPECTED_TURNS]);

        await expect(insertChatTurn(db, "dup", 1)).rejects.toThrow();
      } finally {
        await db.destroy();
      }
    }, 30_000);

    it("is idempotent: re-opening the upgraded database keeps the index absent and does not re-run migration 003", async () => {
      seedLegacyChatDatabase(dbPath);

      const first = await createDatabase(dbPath);
      await first.destroy();
      const second = await createDatabase(dbPath);
      try {
        const versions = await schemaVersions(second);
        expect(versions).toEqual([1, 2, 3]);
        expect(versions.filter((v) => v === 3)).toHaveLength(1);
        expect(await hasRedundantIndex(second)).toBe(false);
        expect(await hasUniqueAutoIndex(second)).toBe(true);

        const count = await second
          .selectFrom("chat_turns")
          .select((eb) => eb.fn.countAll<number>().as("c"))
          .executeTakeFirstOrThrow();
        expect(Number(count.c)).toBe(2);
      } finally {
        await second.destroy();
      }
    }, 30_000);
  });
});
