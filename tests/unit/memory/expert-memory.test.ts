/**
 * Tests for `recallMemory()` — heuristic extraction of an expert's past
 * positions, updated priors, and unresolved questions from the local SQLite
 * turns table (ROADMAP §3.1, recall side).
 *
 * RED at this commit: src/memory/expert-memory.ts does not exist.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { recallMemory } from "../../../src/memory/expert-memory.js";
import { DebateRepository } from "../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../src/memory/repositories/turns.js";

interface Fixture {
  readonly db: CouncilDatabase;
  readonly panelId: string;
  readonly expertId: string;
  readonly debateId: string;
  readonly turns: TurnRepository;
  readonly cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-memrecall-"));
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
    turns: new TurnRepository(db),
    cleanup: async () => {
      await db.destroy();
      try {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* best effort — Windows can hold the libsql file briefly after destroy() */
      }
    },
  };
}

describe("recallMemory", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await makeFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it("returns undefined when the expert has no prior turns", async () => {
    const memory = await recallMemory(fx.db, fx.panelId, "cto");
    expect(memory).toBeUndefined();
  });

  it("returns undefined when the expert slug does not exist on the panel", async () => {
    const memory = await recallMemory(fx.db, fx.panelId, "nonexistent-slug");
    expect(memory).toBeUndefined();
  });

  it("extracts positions (first 1-2 sentences) from each prior expert turn", async () => {
    await fx.turns.create({
      debateId: fx.debateId,
      round: 1,
      seq: 1,
      speakerKind: "expert",
      expertId: fx.expertId,
      content:
        "We should adopt microservices for the billing domain. The blast radius of a monolithic deploy is unacceptable. (Then a much longer explanation follows.)",
    });
    const memory = await recallMemory(fx.db, fx.panelId, "cto");
    expect(memory).toBeDefined();
    expect(memory?.positions.length).toBeGreaterThan(0);
    const first = memory?.positions[0] ?? "";
    expect(first).toContain("microservices for the billing domain");
    // Should NOT contain content from the third sentence
    expect(first).not.toContain("longer explanation");
  });

  it("extracts updated priors from turns containing reversal phrases", async () => {
    await fx.turns.create({
      debateId: fx.debateId,
      round: 1,
      seq: 1,
      speakerKind: "expert",
      expertId: fx.expertId,
      content: "Initial stance: ship now.",
    });
    await fx.turns.create({
      debateId: fx.debateId,
      round: 2,
      seq: 1,
      speakerKind: "expert",
      expertId: fx.expertId,
      content:
        "On reflection, I was wrong about the rollout window. The compliance review must complete first.",
    });
    const memory = await recallMemory(fx.db, fx.panelId, "cto");
    expect(memory?.updatedPriors.length).toBeGreaterThan(0);
    expect(memory?.updatedPriors.join(" ")).toMatch(/I was wrong|on reflection/i);
  });

  it("extracts unresolved questions from turns ending with '?' or marker phrases", async () => {
    await fx.turns.create({
      debateId: fx.debateId,
      round: 1,
      seq: 1,
      speakerKind: "expert",
      expertId: fx.expertId,
      content:
        "We have a position. But the cost model remains unclear given vendor pricing volatility.",
    });
    await fx.turns.create({
      debateId: fx.debateId,
      round: 2,
      seq: 1,
      speakerKind: "expert",
      expertId: fx.expertId,
      content: "How do we pay for the migration?",
    });
    const memory = await recallMemory(fx.db, fx.panelId, "cto");
    expect(memory?.unresolved.length).toBeGreaterThanOrEqual(2);
    const joined = memory?.unresolved.join(" ") ?? "";
    expect(joined).toMatch(/remains unclear/i);
    expect(joined).toMatch(/How do we pay for the migration\?/);
  });

  it("ignores turns from other experts", async () => {
    const other = await new ExpertRepository(fx.db).create({
      panelId: fx.panelId,
      slug: "cfo",
      displayName: "CFO",
      model: "claude-sonnet-4",
      systemMessage: "You are a CFO.",
    });
    await fx.turns.create({
      debateId: fx.debateId,
      round: 1,
      seq: 1,
      speakerKind: "expert",
      expertId: other.id,
      content: "I, the CFO, take stance X.",
    });
    const memory = await recallMemory(fx.db, fx.panelId, "cto");
    expect(memory).toBeUndefined();
  });

  it("respects the maxTurns option, scanning only the most recent N turns", async () => {
    // Insert 5 turns for the CTO; older first, newer last (by seq under same round).
    for (let i = 1; i <= 5; i += 1) {
      await fx.turns.create({
        debateId: fx.debateId,
        round: 1,
        seq: i,
        speakerKind: "expert",
        expertId: fx.expertId,
        content: `Position number ${i}.`,
      });
    }
    const memory = await recallMemory(fx.db, fx.panelId, "cto", { maxTurns: 2 });
    expect(memory?.positions.length).toBe(2);
    // Should be the two MOST RECENT turns (4 and 5), not the first two.
    const joined = memory?.positions.join(" ") ?? "";
    expect(joined).toContain("Position number 4");
    expect(joined).toContain("Position number 5");
    expect(joined).not.toContain("Position number 1");
  });

  it("truncates each memory entry to a reasonable length (~200 chars)", async () => {
    const longSentence = "x".repeat(500) + ".";
    await fx.turns.create({
      debateId: fx.debateId,
      round: 1,
      seq: 1,
      speakerKind: "expert",
      expertId: fx.expertId,
      content: longSentence,
    });
    const memory = await recallMemory(fx.db, fx.panelId, "cto");
    expect(memory?.positions[0]?.length).toBeLessThanOrEqual(210);
  });

  it("aggregates turns across multiple debates for the same panel/expert", async () => {
    const debate2 = await new DebateRepository(fx.db).create({
      panelId: fx.panelId,
      prompt: "second topic",
      moderator: "round-robin",
    });
    await fx.turns.create({
      debateId: fx.debateId,
      round: 1,
      seq: 1,
      speakerKind: "expert",
      expertId: fx.expertId,
      content: "First debate stance.",
    });
    await fx.turns.create({
      debateId: debate2.id,
      round: 1,
      seq: 1,
      speakerKind: "expert",
      expertId: fx.expertId,
      content: "Second debate stance.",
    });
    const memory = await recallMemory(fx.db, fx.panelId, "cto");
    const joined = memory?.positions.join(" ") ?? "";
    expect(joined).toContain("First debate stance");
    expect(joined).toContain("Second debate stance");
  });
});
