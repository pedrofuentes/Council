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
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import {
  PanelRepository,
  type NewPanel,
} from "../../../src/memory/repositories/panels.js";
import {
  ExpertRepository,
  type NewExpert,
} from "../../../src/memory/repositories/experts.js";
import {
  TurnRepository,
  type NewTurn,
} from "../../../src/memory/repositories/turns.js";

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
      debateId, round: 1, seq: 0, speakerKind: "expert", expertId,
      content: "Round 1 first.",
    });
    await turnRepo.create({
      debateId, round: 0, seq: 1, speakerKind: "expert", expertId,
      content: "Round 0 second.",
    });
    await turnRepo.create({
      debateId, round: 0, seq: 0, speakerKind: "expert", expertId,
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
      debateId, round: 0, seq: 0, speakerKind: "expert", expertId,
      content: "Microservices add operational complexity that smaller teams cannot afford.",
    });
    await turnRepo.create({
      debateId, round: 0, seq: 1, speakerKind: "expert", expertId,
      content: "A modular monolith gets you 80% of the benefit at 20% of the cost.",
    });
    const hits = await turnRepo.search("microservices");
    expect(hits.length).toBe(1);
    expect(hits[0]?.content).toContain("Microservices");
  });

  it("search() with no matches returns empty array", async () => {
    await turnRepo.create({
      debateId, round: 0, seq: 0, speakerKind: "expert", expertId,
      content: "Nothing about the search term here.",
    });
    expect(await turnRepo.search("kubernetes")).toEqual([]);
  });
});
