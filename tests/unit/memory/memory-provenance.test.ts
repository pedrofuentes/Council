/**
 * Tests for memory provenance tracking (T-2 / issue #569).
 *
 * Cached expert memory now records WHERE it came from (sourceDebateId),
 * HOW it was produced (derivation: llm_summary | heuristic_scan), and a
 * trust score (0.0–1.0). This makes poisoned cache entries distinguishable
 * from legitimate ones during inspection.
 *
 * RED at this commit: migration v11 has not yet been added, the
 * `persistExtractedMemory` signature still takes 3 params (no
 * provenance), and `recallMemoryWithProvenance` does not exist.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createClient } from "@libsql/client";

import { copyTemplateDb } from "../../helpers/template-db.js";
import { buildMemoryCommand } from "../../../src/cli/commands/memory.js";
import { createDatabase, loadMigrations, type CouncilDatabase } from "../../../src/memory/db.js";
import {
  persistExtractedMemory,
  recallMemoryWithProvenance,
} from "../../../src/memory/expert-memory.js";
import { DebateRepository } from "../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../src/memory/repositories/turns.js";

interface Fixture {
  readonly dir: string;
  readonly dbPath: string;
  readonly db: CouncilDatabase;
  readonly panelId: string;
  readonly expertId: string;
  readonly expertSlug: string;
  readonly debateId: string;
  readonly cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-provenance-"));
  const dbPath = path.join(dir, "council.db");
  await copyTemplateDb(dbPath);
  const db = await createDatabase(dbPath);
  const panel = await new PanelRepository(db).create({
    name: "provenance-panel",
    copilotHome: path.join(dir, "copilot"),
    configJson: "{}",
  });
  const expert = await new ExpertRepository(db).create({
    panelId: panel.id,
    slug: "cto",
    displayName: "CTO",
    model: "claude-sonnet-4",
    systemMessage: "You are a CTO.",
  });
  const debate = await new DebateRepository(db).create({
    panelId: panel.id,
    prompt: "topic",
    moderator: "round-robin",
  });
  return {
    dir,
    dbPath,
    db,
    panelId: panel.id,
    expertId: expert.id,
    expertSlug: "cto",
    debateId: debate.id,
    cleanup: async () => {
      await db.destroy();
      try {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* best effort */
      }
    },
  };
}

interface ProvenanceRow {
  readonly memory_source_debate_id: string | null;
  readonly memory_derivation: string | null;
  readonly memory_trust_score: number | null;
  readonly memory_extracted_at: string | null;
}

async function readProvenanceRow(db: CouncilDatabase, expertId: string): Promise<ProvenanceRow> {
  const result = await sql<ProvenanceRow>`
    SELECT memory_source_debate_id, memory_derivation, memory_trust_score, memory_extracted_at
    FROM experts
    WHERE id = ${expertId}
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`expert ${expertId} not found`);
  return row;
}

describe("memory provenance (T-2 / #569)", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await makeFixture();
  });
  afterEach(async () => {
    await fx.cleanup();
  });

  it("migration v11 creates the four provenance columns on experts", async () => {
    // Reading the columns must succeed; missing columns would throw.
    const result = await sql`
      SELECT memory_source_debate_id, memory_derivation, memory_trust_score, memory_extracted_at
      FROM experts
      LIMIT 0
    `.execute(fx.db);
    expect(result).toBeDefined();
  });

  it("persistExtractedMemory writes provenance columns", async () => {
    const before = Date.now();
    await persistExtractedMemory(
      fx.db,
      fx.expertId,
      {
        positions: ["p"],
        updatedPriors: [],
        unresolved: [],
      },
      {
        sourceDebateId: fx.debateId,
        derivation: "llm_summary",
        trustScore: 0.5,
      },
    );

    const row = await readProvenanceRow(fx.db, fx.expertId);
    expect(row.memory_source_debate_id).toBe(fx.debateId);
    expect(row.memory_derivation).toBe("llm_summary");
    expect(row.memory_trust_score).toBe(0.5);
    expect(row.memory_extracted_at).not.toBeNull();
    const extractedAt = new Date(row.memory_extracted_at ?? "").getTime();
    expect(Number.isFinite(extractedAt)).toBe(true);
    expect(extractedAt).toBeGreaterThanOrEqual(before - 1000);
  });

  it("recallMemoryWithProvenance returns provenance when LLM-cached", async () => {
    await persistExtractedMemory(
      fx.db,
      fx.expertId,
      {
        positions: ["LLM position"],
        updatedPriors: [],
        unresolved: [],
      },
      {
        sourceDebateId: fx.debateId,
        derivation: "llm_summary",
        trustScore: 0.5,
      },
    );

    const recalled = await recallMemoryWithProvenance(fx.db, fx.panelId, fx.expertSlug);
    expect(recalled).toBeDefined();
    expect(recalled?.memory.positions).toEqual(["LLM position"]);
    expect(recalled?.provenance).not.toBeNull();
    expect(recalled?.provenance?.sourceDebateId).toBe(fx.debateId);
    expect(recalled?.provenance?.derivation).toBe("llm_summary");
    expect(recalled?.provenance?.trustScore).toBe(0.5);
    expect(recalled?.provenance?.extractedAt).not.toBeNull();
  });

  it("recallMemoryWithProvenance returns null provenance for the heuristic path", async () => {
    const turnRepo = new TurnRepository(fx.db);
    await turnRepo.create({
      debateId: fx.debateId,
      expertId: fx.expertId,
      speakerKind: "expert",
      round: 0,
      seq: 0,
      content: "We must validate falsifiability before shipping.",
    });

    const recalled = await recallMemoryWithProvenance(fx.db, fx.panelId, fx.expertSlug);
    expect(recalled).toBeDefined();
    expect(recalled?.memory.positions.length).toBeGreaterThan(0);
    // Heuristic memory is computed on-the-fly, not stored, so provenance is null.
    expect(recalled?.provenance).toBeNull();
  });

  it("memory reset clears the four provenance columns", async () => {
    // Seed provenance.
    await persistExtractedMemory(
      fx.db,
      fx.expertId,
      {
        positions: ["p"],
        updatedPriors: [],
        unresolved: [],
      },
      {
        sourceDebateId: fx.debateId,
        derivation: "llm_summary",
        trustScore: 0.5,
      },
    );

    // Close test DB so the CLI command can open its own connection at the same path.
    await fx.db.destroy();

    const prevHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = fx.dir;
    try {
      const cmd = buildMemoryCommand({ write: () => undefined, writeError: () => undefined });
      await cmd.parseAsync(["node", "council-memory", "reset", "provenance-panel", "--yes"]);
    } finally {
      if (prevHome === undefined) delete process.env["COUNCIL_HOME"];
      else process.env["COUNCIL_HOME"] = prevHome;
    }

    const dbAfter = await createDatabase(fx.dbPath);
    try {
      const row = await readProvenanceRow(dbAfter, fx.expertId);
      expect(row.memory_source_debate_id).toBeNull();
      expect(row.memory_derivation).toBeNull();
      expect(row.memory_trust_score).toBeNull();
      expect(row.memory_extracted_at).toBeNull();
    } finally {
      await dbAfter.destroy();
    }
  });

  // Sentinel pr614 #1 🔴 — legacy-upgrade regression.
  //
  // Before migration v11, `experts.extracted_memory_json` could already
  // hold an LLM-cached memory blob with no provenance. After running
  // v11 we MUST NOT mislabel those rows as legitimate `llm_summary` /
  // `0.5`-trust entries. Defaults applied by ALTER TABLE ADD COLUMN
  // would have backfilled exactly that fabricated provenance.
  it("legacy extracted_memory_json rows are not labelled as fabricated LLM provenance", async () => {
    // Simulate a pre-v11 row: extracted_memory_json present, but the
    // provenance columns left at whatever the schema defaults produce
    // (which is what an ALTER TABLE ADD COLUMN would have produced for
    // any row that pre-existed migration v11).
    await sql`
      UPDATE experts
      SET extracted_memory_json = ${JSON.stringify({
        positions: ["legacy cached position"],
        updatedPriors: [],
        unresolved: [],
      })}
      WHERE id = ${fx.expertId}
    `.execute(fx.db);

    const row = await readProvenanceRow(fx.db, fx.expertId);
    // A legacy row has no source debate id — that's the canonical
    // signal that provenance was never recorded.
    expect(row.memory_source_debate_id).toBeNull();

    const recalled = await recallMemoryWithProvenance(fx.db, fx.panelId, fx.expertSlug);
    expect(recalled).toBeDefined();
    expect(recalled?.memory.positions).toEqual(["legacy cached position"]);
    // Legacy rows MUST surface as having no provenance, not as
    // fabricated llm_summary / 0.5 entries.
    expect(recalled?.provenance).toBeNull();
  });

  // Sentinel pr614 #1 🔴 — migration-layer regression.
  //
  // Direct test of migration v11 against a pre-v11 row created by
  // running migrations 1-10 only, inserting an expert with
  // extracted_memory_json, and THEN applying v11. Without the explicit
  // UPDATE in v11, SQLite's ALTER TABLE ADD COLUMN DEFAULT would
  // backfill 'llm_summary' / 0.5 into that legacy row. This test must
  // fail if the UPDATE statement is removed from migration v11.
  it("migration v11 nulls provenance defaults backfilled into pre-existing rows", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      const migrations = loadMigrations();
      const preV11 = migrations.filter((m) => m.version < 11);
      for (const m of preV11) {
        await client.executeMultiple(m.sql);
        await client.execute({
          sql: "INSERT INTO schema_version (version, applied_at) VALUES (?, ?);",
          args: [m.version, new Date().toISOString()],
        });
      }
      const panelId = "panel-legacy";
      const expertId = "expert-legacy";
      await client.execute({
        sql: "INSERT INTO panels (id, name, copilot_home, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?);",
        args: [
          panelId,
          "legacy",
          "/tmp/copilot",
          "{}",
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      });
      await client.execute({
        sql: "INSERT INTO experts (id, panel_id, slug, display_name, model, system_message, copilot_session_id, created_at, extracted_memory_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);",
        args: [
          expertId,
          panelId,
          "legacy-expert",
          "Legacy Expert",
          "gpt-4",
          "you are legacy",
          null,
          new Date().toISOString(),
          JSON.stringify({ positions: ["p"], updatedPriors: [], unresolved: [] }),
        ],
      });

      const v11 = migrations.find((m) => m.version === 11);
      if (!v11) throw new Error("migration v11 not found");
      await client.executeMultiple(v11.sql);

      const result = await client.execute({
        sql: "SELECT memory_source_debate_id, memory_derivation, memory_trust_score, memory_extracted_at, extracted_memory_json FROM experts WHERE id = ?;",
        args: [expertId],
      });
      const row = result.rows[0] as Record<string, unknown>;
      expect(row["extracted_memory_json"]).not.toBeNull();
      expect(row["memory_source_debate_id"]).toBeNull();
      expect(row["memory_derivation"]).toBeNull();
      expect(row["memory_trust_score"]).toBeNull();
      expect(row["memory_extracted_at"]).toBeNull();
    } finally {
      client.close();
    }
  });
});
