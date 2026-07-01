/**
 * Tests for `loadTranscript` + `synthesizeEvents` (src/memory/transcript.ts).
 *
 * Extracted from resume's inline transcript synthesis so both `resume`
 * and `export` can share it (#3.6, also closes Sentinel pr165 #2 for
 * the synthesis half).
 *
 * RED at this commit: src/memory/transcript.ts does not exist.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { copyTemplateDb } from "../../helpers/template-db.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import {
  loadTranscript,
  synthesizeEvents,
  type TranscriptDocument,
} from "../../../src/memory/transcript.js";
import { DebateRepository } from "../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../src/memory/repositories/turns.js";

interface SeedResult {
  panelName: string;
  panelId: string;
  ctoId: string;
  pmId: string;
  debateId: string;
}

async function seed(testDir: string, opts: { withTurns?: boolean; status?: "completed" | "running" | "interrupted" | "aborted" | "failed" } = {}): Promise<SeedResult> {
  const db = await createDatabase(path.join(testDir, "council.db"));
  try {
    const panelRepo = new PanelRepository(db);
    const expertRepo = new ExpertRepository(db);
    const debateRepo = new DebateRepository(db);
    const turnRepo = new TurnRepository(db);

    const panel = await panelRepo.create({
      name: "transcript-test-panel",
      topic: "Should we ship the MVP?",
      copilotHome: path.join(testDir, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    const cto = await expertRepo.create({
      panelId: panel.id,
      slug: "cto",
      displayName: "CTO",
      model: "claude-sonnet-4",
      systemMessage: "You are a CTO.",
    });
    const pm = await expertRepo.create({
      panelId: panel.id,
      slug: "pm",
      displayName: "PM",
      model: "claude-sonnet-4",
      systemMessage: "You are a PM.",
    });
    const debate = await debateRepo.create({
      panelId: panel.id,
      prompt: "Should we ship the MVP?",
      moderator: "round-robin",
    });
    if (opts.withTurns !== false) {
      await turnRepo.create({
        debateId: debate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: cto.id,
        content: "CTO opening",
      });
      await turnRepo.create({
        debateId: debate.id,
        round: 0,
        seq: 1,
        speakerKind: "expert",
        expertId: pm.id,
        content: "PM opening",
      });
      await turnRepo.create({
        debateId: debate.id,
        round: 1,
        seq: 0,
        speakerKind: "expert",
        expertId: cto.id,
        content: "CTO synthesis",
      });
    }
    if (opts.status !== "running") {
      await debateRepo.update(debate.id, {
        status: opts.status ?? "completed",
        endedAt: new Date().toISOString(),
      });
    }
    return {
      panelName: panel.name,
      panelId: panel.id,
      ctoId: cto.id,
      pmId: pm.id,
      debateId: debate.id,
    };
  } finally {
    await db.destroy();
  }
}

describe("loadTranscript", () => {
  let dir: string;
  let db: CouncilDatabase;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-transcript-"));
    await copyTemplateDb(path.join(dir, "council.db"));
    db = await createDatabase(path.join(dir, "council.db"));
    await db.destroy();
  });

  afterEach(async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  it("resolves a panel by name into a TranscriptDocument", async () => {
    const seeded = await seed(dir);
    const fresh = await createDatabase(path.join(dir, "council.db"));
    try {
      const doc = await loadTranscript(fresh, seeded.panelName);
      expect(doc.panel.name).toBe(seeded.panelName);
      expect(doc.panel.topic).toBe("Should we ship the MVP?");
      expect(doc.experts).toHaveLength(2);
      expect(doc.experts.map((e) => e.slug).sort()).toEqual(["cto", "pm"]);
      expect(doc.latestDebate.id).toBe(seeded.debateId);
      expect(doc.latestDebate.status).toBe("completed");
      expect(doc.turns).toHaveLength(3);
    } finally {
      await fresh.destroy();
    }
  });

  it("selects the debate with the most turns by default", async () => {
    const seeded = await seed(dir, { withTurns: false });
    let substantiveDebateId = "";
    const setupDb = await createDatabase(path.join(dir, "council.db"));
    try {
      const debateRepo = new DebateRepository(setupDb);
      const turnRepo = new TurnRepository(setupDb);

      const firstDebate = await debateRepo.create({
        panelId: seeded.panelId,
        prompt: "Original first debate prompt",
        moderator: "round-robin",
      });
      await turnRepo.create({
        debateId: firstDebate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: seeded.ctoId,
        content: "First debate opening",
      });
      await debateRepo.update(firstDebate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });

      const substantiveDebate = await debateRepo.create({
        panelId: seeded.panelId,
        prompt: "Most substantive debate prompt",
        moderator: "round-robin",
      });
      substantiveDebateId = substantiveDebate.id;
      await turnRepo.create({
        debateId: substantiveDebate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: seeded.ctoId,
        content: "Substantive CTO opening",
      });
      await turnRepo.create({
        debateId: substantiveDebate.id,
        round: 0,
        seq: 1,
        speakerKind: "expert",
        expertId: seeded.pmId,
        content: "Substantive PM opening",
      });
      await turnRepo.create({
        debateId: substantiveDebate.id,
        round: 1,
        seq: 0,
        speakerKind: "expert",
        expertId: seeded.ctoId,
        content: "Substantive CTO synthesis",
      });
      await turnRepo.create({
        debateId: substantiveDebate.id,
        round: 1,
        seq: 1,
        speakerKind: "expert",
        expertId: seeded.pmId,
        content: "Substantive PM synthesis",
      });
      await debateRepo.update(substantiveDebate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });

      const latestShortDebate = await debateRepo.create({
        panelId: seeded.panelId,
        prompt: "Latest short debate prompt",
        moderator: "round-robin",
      });
      await turnRepo.create({
        debateId: latestShortDebate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: seeded.ctoId,
        content: "Latest short debate turn",
      });
      await debateRepo.update(latestShortDebate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
    } finally {
      await setupDb.destroy();
    }

    const fresh = await createDatabase(path.join(dir, "council.db"));
    try {
      const doc = await loadTranscript(fresh, seeded.panelName);
      expect(doc.latestDebate.id).toBe(substantiveDebateId);
      expect(doc.latestDebate.prompt).toBe("Most substantive debate prompt");
      expect(doc.turns.map((turn) => turn.content)).toEqual([
        "Substantive CTO opening",
        "Substantive PM opening",
        "Substantive CTO synthesis",
        "Substantive PM synthesis",
      ]);
    } finally {
      await fresh.destroy();
    }
  });

  it("selects the later debate when turn counts are equal (tie-break: latest wins)", async () => {
    // Two debates with EQUAL turn counts (2 each). The later-created debate must win.
    // If the tie-break were reversed (earlier wins), `doc.latestDebate.id` would equal
    // `earlierDebateId` and this test would fail — making the oracle discriminating.
    const seeded = await seed(dir, { withTurns: false });
    let earlierDebateId = "";
    let laterDebateId = "";

    const setupDb = await createDatabase(path.join(dir, "council.db"));
    try {
      const debateRepo = new DebateRepository(setupDb);
      const turnRepo = new TurnRepository(setupDb);

      const earlierDebate = await debateRepo.create({
        panelId: seeded.panelId,
        prompt: "Earlier debate prompt",
        moderator: "round-robin",
      });
      earlierDebateId = earlierDebate.id;
      await turnRepo.create({
        debateId: earlierDebate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: seeded.ctoId,
        content: "Earlier debate — CTO turn",
      });
      await turnRepo.create({
        debateId: earlierDebate.id,
        round: 0,
        seq: 1,
        speakerKind: "expert",
        expertId: seeded.pmId,
        content: "Earlier debate — PM turn",
      });
      await debateRepo.update(earlierDebate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });

      // Created after earlierDebate → higher rowid, same or later started_at.
      // findByPanelId orders ASC so it arrives last in the iteration; the
      // `turnCount === selectedTurnCount` branch must replace `selected` with it.
      const laterDebate = await debateRepo.create({
        panelId: seeded.panelId,
        prompt: "Later debate prompt",
        moderator: "round-robin",
      });
      laterDebateId = laterDebate.id;
      await turnRepo.create({
        debateId: laterDebate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: seeded.ctoId,
        content: "Later debate — CTO turn",
      });
      await turnRepo.create({
        debateId: laterDebate.id,
        round: 0,
        seq: 1,
        speakerKind: "expert",
        expertId: seeded.pmId,
        content: "Later debate — PM turn",
      });
      await debateRepo.update(laterDebate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
    } finally {
      await setupDb.destroy();
    }

    const fresh = await createDatabase(path.join(dir, "council.db"));
    try {
      const doc = await loadTranscript(fresh, seeded.panelName);
      expect(doc.latestDebate.id).toBe(laterDebateId);
      expect(doc.latestDebate.prompt).toBe("Later debate prompt");
      expect(doc.latestDebate.id).not.toBe(earlierDebateId);
      expect(doc.turns.map((t) => t.content)).toEqual([
        "Later debate — CTO turn",
        "Later debate — PM turn",
      ]);
    } finally {
      await fresh.destroy();
    }
  });

  it("accepts an explicit debateId override", async () => {
    const seeded = await seed(dir);
    let explicitDebateId = "";
    const setupDb = await createDatabase(path.join(dir, "council.db"));
    try {
      const debateRepo = new DebateRepository(setupDb);
      const turnRepo = new TurnRepository(setupDb);
      const explicitDebate = await debateRepo.create({
        panelId: seeded.panelId,
        prompt: "Explicitly selected debate",
        moderator: "round-robin",
      });
      explicitDebateId = explicitDebate.id;
      await turnRepo.create({
        debateId: explicitDebate.id,
        round: 0,
        seq: 0,
        speakerKind: "expert",
        expertId: seeded.pmId,
        content: "Explicit debate content",
      });
      await debateRepo.update(explicitDebate.id, {
        status: "completed",
        endedAt: new Date().toISOString(),
      });
    } finally {
      await setupDb.destroy();
    }

    const fresh = await createDatabase(path.join(dir, "council.db"));
    try {
      const doc = await loadTranscript(fresh, seeded.panelName, explicitDebateId);
      expect(doc.latestDebate.id).toBe(explicitDebateId);
      expect(doc.turns.map((turn) => turn.content)).toEqual(["Explicit debate content"]);
    } finally {
      await fresh.destroy();
    }
  });

  it("throws when an explicit debateId is unknown", async () => {
    const seeded = await seed(dir);
    const fresh = await createDatabase(path.join(dir, "council.db"));
    try {
      await expect(loadTranscript(fresh, seeded.panelName, "nonexistent-id")).rejects.toThrow(
        /nonexistent-id|no debate/i,
      );
    } finally {
      await fresh.destroy();
    }
  });

  it("throws when the panel name is unknown", async () => {
    const fresh = await createDatabase(path.join(dir, "council.db"));
    try {
      await expect(loadTranscript(fresh, "no-such-panel")).rejects.toThrow(/no panel/i);
    } finally {
      await fresh.destroy();
    }
  });

  it("error message suggests 'council sessions', not 'council panels'", async () => {
    const fresh = await createDatabase(path.join(dir, "council.db"));
    try {
      await expect(loadTranscript(fresh, "no-such-panel")).rejects.toThrow(/council sessions/i);
      await expect(loadTranscript(fresh, "no-such-panel")).rejects.not.toThrow(/council panels/i);
    } finally {
      await fresh.destroy();
    }
  });

  it("throws when the panel exists but has no debates", async () => {
    // Seed a bare panel with no debate.
    const fresh = await createDatabase(path.join(dir, "council.db"));
    let panelName = "";
    try {
      const panel = await new PanelRepository(fresh).create({
        name: "bare-panel",
        copilotHome: path.join(dir, "copilot"),
        configJson: "{}",
      });
      panelName = panel.name;
    } finally {
      await fresh.destroy();
    }
    const fresh2 = await createDatabase(path.join(dir, "council.db"));
    try {
      await expect(loadTranscript(fresh2, panelName)).rejects.toThrow(/no debates/i);
    } finally {
      await fresh2.destroy();
    }
  });
});

describe("synthesizeEvents", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-synth-"));
    await copyTemplateDb(path.join(dir, "council.db"));
  });
  afterEach(async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  async function loadDoc(): Promise<TranscriptDocument> {
    const seeded = await seed(dir);
    const fresh = await createDatabase(path.join(dir, "council.db"));
    try {
      return await loadTranscript(fresh, seeded.panelName);
    } finally {
      await fresh.destroy();
    }
  }

  it("emits panel.assembled first, debate.end last", async () => {
    const doc = await loadDoc();
    const events = synthesizeEvents(doc);
    expect(events[0]?.kind).toBe("panel.assembled");
    expect(events[events.length - 1]?.kind).toBe("debate.end");
  });

  it("brackets each round with round.start / round.end", async () => {
    const doc = await loadDoc();
    const events = synthesizeEvents(doc);
    const kinds = events.map((e) => e.kind);
    // 2 rounds (0, 1) → 2 round.start + 2 round.end
    expect(kinds.filter((k) => k === "round.start")).toHaveLength(2);
    expect(kinds.filter((k) => k === "round.end")).toHaveLength(2);
  });

  it("emits one turn.start + turn.end pair per persisted turn row", async () => {
    const doc = await loadDoc();
    const events = synthesizeEvents(doc);
    expect(events.filter((e) => e.kind === "turn.start")).toHaveLength(3);
    expect(events.filter((e) => e.kind === "turn.end")).toHaveLength(3);
  });

  it("zero-turn debate emits panel.assembled + debate.end only (no rounds, no turns)", async () => {
    const seeded = await seed(dir, { withTurns: false });
    const fresh = await createDatabase(path.join(dir, "council.db"));
    let doc: TranscriptDocument;
    try {
      doc = await loadTranscript(fresh, seeded.panelName);
    } finally {
      await fresh.destroy();
    }
    const events = synthesizeEvents(doc);
    expect(events.map((e) => e.kind)).toEqual(["panel.assembled", "debate.end"]);
  });

  it.each(["running", "interrupted"] as const)(
    "status='%s' debate maps to debate.end.reason='aborted'",
    async (status) => {
      const seeded = await seed(dir, { status });
      const fresh = await createDatabase(path.join(dir, "council.db"));
      let doc: TranscriptDocument;
      try {
        doc = await loadTranscript(fresh, seeded.panelName);
      } finally {
        await fresh.destroy();
      }
      const events = synthesizeEvents(doc);
      const last = events[events.length - 1];
      expect(last?.kind).toBe("debate.end");
      expect((last as { reason?: string }).reason).toBe("aborted");
    },
  );

  it.each([
    { status: "completed", expectedReason: "completed" },
    { status: "aborted", expectedReason: "aborted" },
    { status: "failed", expectedReason: "failed" },
  ] as const)("status='$status' maps to debate.end.reason='$expectedReason'", async ({ status, expectedReason }) => {
    const seeded = await seed(dir, { status });
    const fresh = await createDatabase(path.join(dir, "council.db"));
    let doc: TranscriptDocument;
    try {
      doc = await loadTranscript(fresh, seeded.panelName);
    } finally {
      await fresh.destroy();
    }
    const events = synthesizeEvents(doc);
    const last = events[events.length - 1];
    expect(last?.kind).toBe("debate.end");
    expect((last as { reason?: string }).reason).toBe(expectedReason);
  });
});
