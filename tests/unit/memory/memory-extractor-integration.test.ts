/**
 * Integration tests for the LLM-based memory pipeline:
 *
 *  - Migration 003 adds the `extracted_memory_json` column to experts.
 *  - `persistExtractedMemory()` writes ExpertMemory as JSON into that
 *    column for an expert.
 *  - `recallMemory()` prefers the cached LLM memory over the heuristic
 *    when present and non-empty.
 *
 * RED at this commit: migration 003 / persistExtractedMemory don't exist
 * and recallMemory has no LLM-cache code path.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import {
  persistExtractedMemory,
  recallMemory,
} from "../../../src/memory/expert-memory.js";
import { DebateRepository } from "../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../src/memory/repositories/turns.js";

interface Fixture {
  readonly db: CouncilDatabase;
  readonly panelId: string;
  readonly expertId: string;
  readonly debateId: string;
  readonly cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-memextract-"));
  const db = await createDatabase(path.join(dir, "council.db"));
  const panel = await new PanelRepository(db).create({
    name: "test-panel",
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
    db,
    panelId: panel.id,
    expertId: expert.id,
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

describe("LLM memory persistence + recall", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await makeFixture();
  });
  afterEach(async () => {
    await fx.cleanup();
  });

  it("migration adds the extracted_memory_json column to experts", async () => {
    // PRAGMA table_info would be ideal; libsql exposes it via raw query.
    // We verify indirectly: persistExtractedMemory must succeed (would
    // throw on missing column).
    await persistExtractedMemory(fx.db, fx.expertId, {
      positions: ["a"],
      updatedPriors: [],
      unresolved: [],
    });
    // No throw → column exists.
    expect(true).toBe(true);
  });

  it("recallMemory returns the persisted LLM memory when present, bypassing heuristic", async () => {
    // Seed turns that the heuristic would otherwise extract.
    const turnRepo = new TurnRepository(fx.db);
    await turnRepo.create({
      debateId: fx.debateId,
      expertId: fx.expertId,
      speakerKind: "expert",
      round: 0,
      seq: 0,
      content: "Heuristic would extract this opener.",
    });

    // Now persist a distinctly different LLM-extracted memory.
    await persistExtractedMemory(fx.db, fx.expertId, {
      positions: ["LLM-distilled position."],
      updatedPriors: ["LLM-distilled prior update."],
      unresolved: ["LLM-distilled open question?"],
    });

    const recalled = await recallMemory(fx.db, fx.panelId, "cto");
    expect(recalled).toBeDefined();
    expect(recalled?.positions).toEqual(["LLM-distilled position."]);
    expect(recalled?.updatedPriors).toEqual(["LLM-distilled prior update."]);
    expect(recalled?.unresolved).toEqual(["LLM-distilled open question?"]);
    // Heuristic content must NOT bleed in.
    expect(recalled?.positions.join(" ")).not.toContain("Heuristic");
  });

  it("recallMemory falls back to heuristic when no LLM memory is persisted", async () => {
    const turnRepo = new TurnRepository(fx.db);
    await turnRepo.create({
      debateId: fx.debateId,
      expertId: fx.expertId,
      speakerKind: "expert",
      round: 0,
      seq: 0,
      content: "We must validate falsifiability before shipping. An open question remains: how?",
    });

    const recalled = await recallMemory(fx.db, fx.panelId, "cto");
    expect(recalled).toBeDefined();
    // Heuristic produces non-empty positions for any turn.
    expect(recalled?.positions.length).toBeGreaterThan(0);
  });

  it("recallMemory falls back to heuristic when persisted memory is empty (all arrays empty)", async () => {
    const turnRepo = new TurnRepository(fx.db);
    await turnRepo.create({
      debateId: fx.debateId,
      expertId: fx.expertId,
      speakerKind: "expert",
      round: 0,
      seq: 0,
      content: "We must validate falsifiability before shipping.",
    });

    // Persist explicitly-empty LLM memory (e.g. extractor returned EMPTY_MEMORY).
    await persistExtractedMemory(fx.db, fx.expertId, {
      positions: [],
      updatedPriors: [],
      unresolved: [],
    });

    const recalled = await recallMemory(fx.db, fx.panelId, "cto");
    expect(recalled).toBeDefined();
    // Heuristic must kick in since the cache is empty.
    expect(recalled?.positions.length).toBeGreaterThan(0);
  });
});
