/**
 * Sentinel pr273 cycle 1 #1 🔴 — the post-debate hook MUST extract
 * memory across ALL of the expert's prior debates, not just the
 * current one. Otherwise the single cache column gets overwritten on
 * each debate and older memory is silently lost.
 *
 * RED contract for `runExtractMemoryHook`:
 *   - When the expert has turns across multiple debates, the
 *     extractor receives content from all of them (bounded by
 *     DEFAULT_MAX_TURNS / DEFAULT_MAX_DEBATES, matching the
 *     heuristic scan).
 *   - Only the most-recent N turns are included, but they include
 *     content from prior debates — not only the current one.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sql } from "kysely";

import { runExtractMemoryHook } from "../../../src/cli/extract-memory-hook.js";
import type { CouncilEngine, EngineEvent, ExpertSpec } from "../../../src/engine/index.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { DebateRepository } from "../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../src/memory/repositories/turns.js";

class CapturingEngine implements CouncilEngine {
  readonly capturedPrompts: string[] = [];
  async start(): Promise<void> {
    /* no-op */
  }
  async stop(): Promise<void> {
    /* no-op */
  }
  async addExpert(_: ExpertSpec): Promise<void> {
    /* no-op */
  }
  async removeExpert(_: string): Promise<void> {
    /* no-op */
  }
  async *send(args: {
    readonly prompt: string;
    readonly expertId: string;
  }): AsyncIterable<EngineEvent> {
    this.capturedPrompts.push(args.prompt);
    yield {
      type: "delta",
      expertId: args.expertId,
      content: '{"positions":[],"updatedPriors":[],"unresolved":[]}',
    };
    yield { type: "end", expertId: args.expertId };
  }
}

describe("runExtractMemoryHook — cross-debate gathering (Sentinel pr273 #1 🔴)", () => {
  let dir: string;
  let db: CouncilDatabase;
  let panelId: string;
  let expertId: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-hook-x-"));
    db = await createDatabase(path.join(dir, "council.db"));
    const panel = await new PanelRepository(db).create({
      name: "p",
      copilotHome: path.join(dir, "copilot"),
      configJson: "{}",
    });
    panelId = panel.id;
    const e = await new ExpertRepository(db).create({
      panelId,
      slug: "cto",
      displayName: "CTO",
      model: "claude-sonnet-4",
      systemMessage: "You are a CTO.",
    });
    expertId = e.id;
  });

  afterEach(async () => {
    await db.destroy();
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  it("includes turns from prior debates, not only the current debate", async () => {
    const debateRepo = new DebateRepository(db);
    const turnRepo = new TurnRepository(db);

    // Debate 1 (older).
    const d1 = await debateRepo.create({
      panelId,
      prompt: "Older topic",
      moderator: "round-robin",
    });
    await turnRepo.create({
      debateId: d1.id,
      expertId,
      speakerKind: "expert",
      round: 0,
      seq: 0,
      content: "ANCHOR_FROM_OLDER_DEBATE — falsifiability matters most.",
    });

    // Debate 2 (current).
    const d2 = await debateRepo.create({
      panelId,
      prompt: "Newer topic",
      moderator: "round-robin",
    });
    await turnRepo.create({
      debateId: d2.id,
      expertId,
      speakerKind: "expert",
      round: 0,
      seq: 0,
      content: "ANCHOR_FROM_NEWER_DEBATE — ship the smallest credible test.",
    });

    const engine = new CapturingEngine();
    await runExtractMemoryHook({
      engine,
      db,
      panelId,
      debateId: d2.id,
      expertSlugToId: { cto: expertId },
      humanSlugs: new Set<string>(),
      model: "claude-sonnet-4",
      writeError: () => undefined,
    });

    // The extractor must see BOTH anchors in its prompt — i.e. the
    // hook gathered turns across debates, not only the current one.
    const promptForExpert = engine.capturedPrompts.find((p) =>
      p.includes("ANCHOR_FROM_NEWER_DEBATE"),
    );
    expect(promptForExpert).toBeDefined();
    expect(promptForExpert).toContain("ANCHOR_FROM_OLDER_DEBATE");

    // Provenance (T-2 / #569): the hook must record the current debate
    // id as the source, derivation = llm_summary, and trustScore = 0.5.
    const provRows = await sql<{
      readonly memory_source_debate_id: string | null;
      readonly memory_derivation: string | null;
      readonly memory_trust_score: number | null;
      readonly memory_extracted_at: string | null;
    }>`
      SELECT memory_source_debate_id, memory_derivation, memory_trust_score, memory_extracted_at
      FROM experts WHERE id = ${expertId}
    `.execute(db);
    const prov = provRows.rows[0];
    expect(prov).toBeDefined();
    expect(prov?.memory_source_debate_id).toBe(d2.id);
    expect(prov?.memory_derivation).toBe("llm_summary");
    expect(prov?.memory_trust_score).toBe(0.5);
    expect(prov?.memory_extracted_at).not.toBeNull();
  });
});
