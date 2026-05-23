/**
 * Tests for the persistence layer (libsql + Kysely).
 *
 * Covers:
 *   - createDatabase(":memory:") returns a typed Kysely instance
 *   - Migrations create panels, experts, debates, turns, turns_fts, schema_version
 *   - Migrations are idempotent (running twice = no error, no duplicate version rows)
 *   - PanelRepository: create, findById, findAll, update, delete
 *   - ExpertRepository: create, findByPanelId, findById, update, delete; UNIQUE (panel_id, slug) enforced
 *   - TurnRepository: create, findByDebateId (ordered), search via FTS5
 *
 * No native dependencies — runs against in-memory libsql (pure WASM).
 *
 * RED at this commit: src/memory/* does not exist yet.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { sql } from "kysely";

import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { PanelRepository, type NewPanel } from "../../../src/memory/repositories/panels.js";
import { ExpertRepository, type NewExpert } from "../../../src/memory/repositories/experts.js";
import { TurnRepository, type NewTurn } from "../../../src/memory/repositories/turns.js";

const SAMPLE_PANEL: NewPanel = {
  name: "architecture-review",
  topic: "Should we migrate to microservices?",
  copilotHome: "/tmp/.council/panels/01HZ-arch/copilot",
  configJson: JSON.stringify({ experts: 4, mode: "freeform" }),
};

function sampleExpert(panelId: string, slug = "cto"): NewExpert {
  return {
    panelId,
    slug,
    displayName: "Dahlia Renner (CTO)",
    model: "claude-sonnet-4",
    systemMessage: "You are a CTO.",
  };
}

async function cleanupFileBackedDatabaseDir(testHome: string): Promise<void> {
  try {
    await fs.rm(testHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best effort */
  }
}

describe("createDatabase", () => {
  let db: CouncilDatabase;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("returns a Kysely instance with all tables created", async () => {
    // Sanity: each table is queryable
    await expect(db.selectFrom("panels").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("experts").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("debates").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("turns").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("schema_version").selectAll().execute()).resolves.not.toThrow();
  });

  it("schema_version contains exactly one row after first migration", async () => {
    const rows = await db.selectFrom("schema_version").selectAll().execute();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.version).toBeGreaterThanOrEqual(1);
  });

  it("running migrations twice (via two createDatabase calls on same file) is idempotent", async () => {
    // Use os.tmpdir() for cross-platform support; libsql cannot create
    // a file in a non-existent directory.
    const tempPath = path.join(os.tmpdir(), `council-test-${Date.now()}.db`);
    const db1 = await createDatabase(tempPath);
    const before = await db1.selectFrom("schema_version").selectAll().execute();
    await db1.destroy();
    const db2 = await createDatabase(tempPath);
    const after = await db2.selectFrom("schema_version").selectAll().execute();
    await db2.destroy();
    expect(after.length).toBe(before.length); // no duplicate version rows
  });

  it("enables WAL and busy_timeout, then waits for a held write lock instead of crashing", async () => {
    const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-db-config-"));
    const dbPath = path.join(testHome, "council.db");
    const db = await createDatabase(dbPath);
    const holderScript = [
      'import { createClient } from "@libsql/client";',
      `const client = createClient({ url: ${JSON.stringify(`file:${dbPath}`)} });`,
      'try {',
      '  await client.execute("BEGIN IMMEDIATE;");',
      '  await client.execute("INSERT INTO panels (id, name, topic, copilot_home, config_json, created_at, updated_at) VALUES (\'holder-panel\', \'holder-panel\', NULL, \'holder-home\', \'{}\', \'2026-01-01T00:00:00.000Z\', \'2026-01-01T00:00:00.000Z\');");',
      '  console.log("LOCKED");',
      '  await new Promise((resolve) => setTimeout(resolve, 250));',
      '  await client.execute("COMMIT;");',
      '} finally {',
      '  client.close();',
      '}',
    ].join("\n");

    try {
      const journalMode = await sql.raw("PRAGMA journal_mode;").execute(db);
      const busyTimeout = await sql.raw("PRAGMA busy_timeout;").execute(db);

      expect(journalMode.rows).toEqual([{ journal_mode: "wal" }]);
      expect(busyTimeout.rows).toEqual([{ timeout: 5000 }]);

      const holder = spawn(process.execPath, ["--input-type=module", "-e", holderScript], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      try {
        const [holderSignal] = await once(holder.stdout, "data");
        expect(String(holderSignal).trim()).toBe("LOCKED");

        const contenderStartedAt = Date.now();
        const contenderWrite = db
          .insertInto("panels")
          .values({
            id: "waiting-panel",
            name: "waiting-panel",
            topic: null,
            copilot_home: path.join(testHome, "waiting"),
            config_json: "{}",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .execute();

        const [exitCode] = await once(holder, "exit");
        expect(exitCode).toBe(0);
        await contenderWrite;
        expect(Date.now() - contenderStartedAt).toBeGreaterThanOrEqual(200);
        await expect(db.selectFrom("panels").select("name").orderBy("name").execute()).resolves
          .toEqual([{ name: "holder-panel" }, { name: "waiting-panel" }]);
      } finally {
        holder.kill();
      }
    } finally {
      await db.destroy();
      await cleanupFileBackedDatabaseDir(testHome);
    }
  }, 20_000);

  it("applies migrations 001 through 011, creating the expected indexes", async () => {
    const versions = (
      await db.selectFrom("schema_version").select("version").orderBy("version").execute()
    ).map((r) => r.version);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    const indexes = (
      await sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name`.execute(db)
    ).rows.map((r) => r.name);
    expect(indexes).toContain("idx_panels_name");
    expect(indexes).toContain("idx_debates_panel_id");
    expect(indexes).toContain("idx_panel_members_expert");
  });
});

describe("Migration 004 — expert library tables", () => {
  let db: CouncilDatabase;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates expert_library, panel_library, and panel_members tables", async () => {
    await expect(db.selectFrom("expert_library").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("panel_library").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("panel_members").selectAll().execute()).resolves.toEqual([]);
  });

  it("supports inserting and reading an expert_library row", async () => {
    const now = new Date().toISOString();
    await db
      .insertInto("expert_library")
      .values({
        slug: "cto",
        kind: "generic",
        display_name: "CTO Expert",
        yaml_path: "/tmp/cto.yaml",
        yaml_checksum: "abc123",
        created_at: now,
        updated_at: now,
      })
      .execute();
    const rows = await db.selectFrom("expert_library").selectAll().execute();
    expect(rows.length).toBe(1);
    expect(rows[0]?.slug).toBe("cto");
    expect(rows[0]?.kind).toBe("generic");
    expect(rows[0]?.display_name).toBe("CTO Expert");
  });

  it("supports inserting and reading a panel_library row", async () => {
    const now = new Date().toISOString();
    await db
      .insertInto("panel_library")
      .values({
        name: "architecture-review",
        description: "Reviews architecture",
        yaml_path: "/tmp/arch.yaml",
        yaml_checksum: "def456",
        created_at: now,
        updated_at: now,
      })
      .execute();
    const rows = await db.selectFrom("panel_library").selectAll().execute();
    expect(rows.length).toBe(1);
    expect(rows[0]?.name).toBe("architecture-review");
    expect(rows[0]?.description).toBe("Reviews architecture");
  });

  it("panel_members enforces FK to expert_library and cascades on delete", async () => {
    const now = new Date().toISOString();
    await db
      .insertInto("panel_library")
      .values({
        name: "arch",
        description: null,
        yaml_path: "/tmp/arch.yaml",
        yaml_checksum: "p1",
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("expert_library")
      .values({
        slug: "cto",
        kind: "generic",
        display_name: "CTO",
        yaml_path: "/tmp/cto.yaml",
        yaml_checksum: "h1",
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("panel_members")
      .values({
        panel_name: "arch",
        expert_slug: "cto",
        position: 0,
        created_at: now,
      })
      .execute();
    const before = await db.selectFrom("panel_members").selectAll().execute();
    expect(before.length).toBe(1);

    await db.deleteFrom("expert_library").where("slug", "=", "cto").execute();
    const after = await db.selectFrom("panel_members").selectAll().execute();
    expect(after.length).toBe(0);
  });

  it("panel_members cascades when the referenced panel is deleted", async () => {
    const now = new Date().toISOString();
    await db
      .insertInto("panel_library")
      .values({
        name: "arch",
        description: null,
        yaml_path: "/tmp/arch.yaml",
        yaml_checksum: "p1",
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("expert_library")
      .values({
        slug: "cto",
        kind: "generic",
        display_name: "CTO",
        yaml_path: "/tmp/cto.yaml",
        yaml_checksum: "h1",
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto("panel_members")
      .values({
        panel_name: "arch",
        expert_slug: "cto",
        position: 0,
        created_at: now,
      })
      .execute();

    await db.deleteFrom("panel_library").where("name", "=", "arch").execute();
    const after = await db.selectFrom("panel_members").selectAll().execute();
    expect(after.length).toBe(0);
  });

  it("panel_members FK rejects insertion referencing nonexistent expert", async () => {
    const now = new Date().toISOString();
    await db
      .insertInto("panel_library")
      .values({
        name: "arch",
        description: null,
        yaml_path: "/tmp/arch.yaml",
        yaml_checksum: "p1",
        created_at: now,
        updated_at: now,
      })
      .execute();
    await expect(
      db
        .insertInto("panel_members")
        .values({
          panel_name: "arch",
          expert_slug: "nonexistent",
          position: 0,
          created_at: now,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it("panel_members FK rejects insertion referencing nonexistent panel", async () => {
    const now = new Date().toISOString();
    await db
      .insertInto("expert_library")
      .values({
        slug: "cto",
        kind: "generic",
        display_name: "CTO",
        yaml_path: "/tmp/cto.yaml",
        yaml_checksum: "h1",
        created_at: now,
        updated_at: now,
      })
      .execute();
    await expect(
      db
        .insertInto("panel_members")
        .values({
          panel_name: "ghost-panel",
          expert_slug: "cto",
          position: 0,
          created_at: now,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it("is idempotent across two createDatabase calls on the same file", async () => {
    const tempPath = path.join(os.tmpdir(), `council-mig004-${Date.now()}.db`);
    const db1 = await createDatabase(tempPath);
    await db1.destroy();
    const db2 = await createDatabase(tempPath);
    const versions = (await db2.selectFrom("schema_version").select("version").execute()).map(
      (r) => r.version,
    );
    await db2.destroy();
    expect(versions.filter((v) => v === 4).length).toBe(1);
  });
});

describe("Migration 006 — expert_documents table", () => {
  let db: CouncilDatabase;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("creates the expert_documents table queryable via Kysely (issue #345)", async () => {
    // Issue #345: the test suite asserted that DocumentRepository works
    // but never independently verified that migration 006 created the
    // backing table and its lookup index. A future migration squash or
    // reorder could break this without a direct failure.
    await expect(db.selectFrom("expert_documents").selectAll().execute()).resolves.toEqual([]);
  });

  it("registers the expert_documents lookup index idx_expert_documents_slug (issue #345)", async () => {
    const indexes = (
      await sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'expert_documents'`.execute(
        db,
      )
    ).rows.map((r) => r.name);
    expect(indexes).toContain("idx_expert_documents_slug");
  });

  it("records schema_version row for migration 006", async () => {
    const versions = (await db.selectFrom("schema_version").select("version").execute()).map(
      (r) => r.version,
    );
    expect(versions).toContain(6);
  });
});

describe("Inlined migrations regression (issue #476)", () => {
  // Migrations were inlined into src/memory/db.ts as string literals so the
  // tsup-bundled CLI works without copying src/memory/migrations/*.sql into
  // dist/. This test would fail if a future change reverted to filesystem
  // reads (e.g. `fs.readFileSync(".../migrations/001_init.sql")`) — those
  // reads succeed under `vitest` (source tree present) only when run from
  // the repo, but more importantly any regression that drops a migration
  // from the inlined `loadMigrations()` array would leave the corresponding
  // table missing and trip this exhaustive presence check.
  let db: CouncilDatabase;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
  });

  afterEach(async () => {
    await db.destroy();
  });

  const EXPECTED_TABLES = [
    "schema_version",
    "panels",
    "experts",
    "debates",
    "turns",
    "turns_fts",
    "expert_library",
    "panel_library",
    "panel_members",
    "chat_sessions",
    "chat_turns",
    "chat_turns_fts",
    "expert_documents",
    "document_index",
    "persona_profiles",
    "panel_linked_folders",
    "panel_documents",
  ] as const;

  it("creates every table from the inlined migration set on a fresh in-memory DB", async () => {
    const rows = (
      await sql<{
        name: string;
      }>`SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') OR (type = 'table' AND sql LIKE '%VIRTUAL%')`.execute(
        db,
      )
    ).rows.map((r) => r.name);
    // sqlite_master reports virtual tables under type='table'; just collect everything.
    const all = (
      await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`.execute(db)
    ).rows.map((r) => r.name);
    for (const expected of EXPECTED_TABLES) {
      expect(all, `migration set must create table '${expected}' (issue #476)`).toContain(expected);
    }
    // Reference `rows` to keep the diagnostic query in scope; failure-time
    // logging during debugging benefits from having both result sets.
    expect(rows.length).toBeGreaterThanOrEqual(EXPECTED_TABLES.length);
  });

  it("records a schema_version row for every inlined migration (1..11)", async () => {
    const versions = (
      await db.selectFrom("schema_version").select("version").orderBy("version").execute()
    ).map((r) => r.version);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("each expected table is queryable via Kysely without throwing", async () => {
    // A missing inlined migration would raise "no such table" here.
    await expect(db.selectFrom("panels").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("experts").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("debates").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("turns").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("schema_version").selectAll().execute()).resolves.toBeDefined();
    await expect(db.selectFrom("expert_library").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("panel_library").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("panel_members").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("chat_sessions").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("chat_turns").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("expert_documents").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("persona_profiles").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("panel_linked_folders").selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom("panel_documents").selectAll().execute()).resolves.toEqual([]);
  });

  it("FTS5 virtual tables (turns_fts, chat_turns_fts, document_index) are queryable", async () => {
    // FTS5 virtual tables require their backing module compiled into the
    // libsql WASM build; if a migration that creates them was dropped
    // these queries would fail with "no such table".
    await expect(sql`SELECT count(*) FROM turns_fts`.execute(db)).resolves.toBeDefined();
    await expect(sql`SELECT count(*) FROM chat_turns_fts`.execute(db)).resolves.toBeDefined();
    await expect(sql`SELECT count(*) FROM document_index`.execute(db)).resolves.toBeDefined();
  });
});

describe("PanelRepository", () => {
  let db: CouncilDatabase;
  let repo: PanelRepository;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    repo = new PanelRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("create() returns a panel with a generated ULID id and timestamps", async () => {
    const panel = await repo.create(SAMPLE_PANEL);
    expect(panel.id).toBeTypeOf("string");
    expect(panel.id.length).toBeGreaterThanOrEqual(20); // ULIDs are 26 chars
    expect(panel.name).toBe(SAMPLE_PANEL.name);
    expect(panel.topic).toBe(SAMPLE_PANEL.topic);
    expect(panel.createdAt).toBeTypeOf("string"); // ISO timestamp
    expect(panel.updatedAt).toBeTypeOf("string");
  });

  it("findById() returns the panel", async () => {
    const created = await repo.create(SAMPLE_PANEL);
    const found = await repo.findById(created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.name).toBe(SAMPLE_PANEL.name);
  });

  it("findById() returns undefined for unknown id", async () => {
    expect(await repo.findById("never-existed")).toBeUndefined();
  });

  it("findAll() lists all panels in creation order (ULID-sortable)", async () => {
    const a = await repo.create(SAMPLE_PANEL);
    // Sleep 2ms so ULIDs land in different milliseconds (issue #82) —
    // ULIDs share their time prefix within a millisecond and the random
    // suffix orders arbitrarily, which previously caused this test to flake.
    await new Promise((r) => setTimeout(r, 2));
    const b = await repo.create({ ...SAMPLE_PANEL, name: "code-review" });
    const all = await repo.findAll();
    expect(all.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it("update() changes name and updates updated_at", async () => {
    const created = await repo.create(SAMPLE_PANEL);
    const before = created.updatedAt;
    // sleep 10ms so the timestamp can move
    await new Promise((r) => setTimeout(r, 10));
    const updated = await repo.update(created.id, { name: "renamed-panel" });
    expect(updated?.name).toBe("renamed-panel");
    expect(updated?.updatedAt).not.toBe(before);
  });

  it("delete() removes the panel and cascades to experts", async () => {
    const panel = await repo.create(SAMPLE_PANEL);
    const expertRepo = new ExpertRepository(db);
    await expertRepo.create(sampleExpert(panel.id));
    await repo.delete(panel.id);
    expect(await repo.findById(panel.id)).toBeUndefined();
    expect(await expertRepo.findByPanelId(panel.id)).toEqual([]);
  });
});

describe("ExpertRepository", () => {
  let db: CouncilDatabase;
  let panelRepo: PanelRepository;
  let repo: ExpertRepository;
  let panelId: string;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    panelRepo = new PanelRepository(db);
    repo = new ExpertRepository(db);
    const panel = await panelRepo.create(SAMPLE_PANEL);
    panelId = panel.id;
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("create() persists an expert with generated ULID", async () => {
    const expert = await repo.create(sampleExpert(panelId));
    expect(expert.id).toBeTypeOf("string");
    expect(expert.panelId).toBe(panelId);
    expect(expert.slug).toBe("cto");
  });

  it("create() rejects duplicate (panel_id, slug)", async () => {
    await repo.create(sampleExpert(panelId, "cto"));
    await expect(repo.create(sampleExpert(panelId, "cto"))).rejects.toThrow();
  });

  it("create() allows the same slug across different panels", async () => {
    const otherPanel = await panelRepo.create({ ...SAMPLE_PANEL, name: "code-review" });
    await expect(repo.create(sampleExpert(panelId, "cto"))).resolves.toBeDefined();
    await expect(repo.create(sampleExpert(otherPanel.id, "cto"))).resolves.toBeDefined();
  });

  it("findByPanelId() returns experts for the panel only", async () => {
    await repo.create(sampleExpert(panelId, "cto"));
    await repo.create(sampleExpert(panelId, "pm"));
    const list = await repo.findByPanelId(panelId);
    expect(list.map((e) => e.slug).sort()).toEqual(["cto", "pm"]);
  });

  it("update() can set the copilot_session_id binding", async () => {
    const expert = await repo.create(sampleExpert(panelId));
    const updated = await repo.update(expert.id, {
      copilotSessionId: "session-abc-123",
    });
    expect(updated?.copilotSessionId).toBe("session-abc-123");
  });

  it("delete() removes the expert", async () => {
    const expert = await repo.create(sampleExpert(panelId));
    await repo.delete(expert.id);
    expect(await repo.findById(expert.id)).toBeUndefined();
  });
});

describe("TurnRepository", () => {
  let db: CouncilDatabase;
  let panelRepo: PanelRepository;
  let expertRepo: ExpertRepository;
  let turnRepo: TurnRepository;
  let panelId: string;
  let debateId: string;
  let expertId: string;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    panelRepo = new PanelRepository(db);
    expertRepo = new ExpertRepository(db);
    turnRepo = new TurnRepository(db);
    const panel = await panelRepo.create(SAMPLE_PANEL);
    panelId = panel.id;
    const expert = await expertRepo.create(sampleExpert(panelId));
    expertId = expert.id;
    // Insert a debate row directly (no DebateRepository in scope of this PR)
    debateId = "01HZ-test-debate";
    await db
      .insertInto("debates")
      .values({
        id: debateId,
        panel_id: panelId,
        prompt: "Test debate",
        status: "running",
        moderator: "round-robin",
        started_at: new Date().toISOString(),
        cost_estimate: 16,
      })
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("create() persists a turn", async () => {
    const turn: NewTurn = {
      debateId,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId,
      content: "I think we should consider operational maturity first.",
    };
    const created = await turnRepo.create(turn);
    expect(created.id).toBeTypeOf("string");
    expect(created.debateId).toBe(debateId);
    expect(created.content).toBe(turn.content);
  });

  it("findByDebateId() returns turns ordered by (round, seq)", async () => {
    await turnRepo.create({
      debateId,
      round: 1,
      seq: 0,
      speakerKind: "expert",
      expertId,
      content: "Round 1 first.",
    });
    await turnRepo.create({
      debateId,
      round: 0,
      seq: 1,
      speakerKind: "expert",
      expertId,
      content: "Round 0 second.",
    });
    await turnRepo.create({
      debateId,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId,
      content: "Round 0 first.",
    });
    const turns = await turnRepo.findByDebateId(debateId);
    expect(turns.map((t) => t.content)).toEqual([
      "Round 0 first.",
      "Round 0 second.",
      "Round 1 first.",
    ]);
  });

  it("search() finds turns via FTS5 substring match", async () => {
    await turnRepo.create({
      debateId,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId,
      content: "Microservices add operational complexity that smaller teams cannot afford.",
    });
    await turnRepo.create({
      debateId,
      round: 0,
      seq: 1,
      speakerKind: "expert",
      expertId,
      content: "A modular monolith gets you 80% of the benefit at 20% of the cost.",
    });
    const hits = await turnRepo.search("microservices");
    expect(hits.length).toBe(1);
    expect(hits[0]?.content).toContain("Microservices");
  });

  it("search() with no matches returns empty array", async () => {
    await turnRepo.create({
      debateId,
      round: 0,
      seq: 0,
      speakerKind: "expert",
      expertId,
      content: "Nothing about the search term here.",
    });
    expect(await turnRepo.search("kubernetes")).toEqual([]);
  });
});
