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

async function seed(testDir: string, opts: { withTurns?: boolean; status?: "completed" | "running" } = {}): Promise<SeedResult> {
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
        status: "completed",
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

  it("throws when the panel name is unknown", async () => {
    const fresh = await createDatabase(path.join(dir, "council.db"));
    try {
      await expect(loadTranscript(fresh, "no-such-panel")).rejects.toThrow(/no panel/i);
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

  it("status='running' debate maps to debate.end.reason='aborted'", async () => {
    const seeded = await seed(dir, { status: "running" });
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
  });
});
