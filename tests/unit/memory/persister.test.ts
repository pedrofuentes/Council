/**
 * Tests for DebatePersister — subscribes to a Debate event stream and
 * writes debates + turns to the database as the debate progresses.
 *
 * Persister is a passthrough: every event from the source stream is
 * yielded onward unchanged. Side-effect writes happen between the
 * receive and the yield so consumers can assume "if the event reached
 * me, the row is in the DB".
 *
 * RED at this commit: src/memory/persister.ts does not exist.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Debate, type DebateConfig } from "../../../src/core/debate.js";
import type { DebateEvent } from "../../../src/core/types.js";
import type { ExpertSpec } from "../../../src/engine/index.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";

import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { DebateRepository } from "../../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../../src/memory/repositories/turns.js";
import { DebatePersister } from "../../../src/memory/persister.js";

const cto: ExpertSpec = {
  id: "01HZ-cto",
  slug: "cto",
  displayName: "CTO",
  model: "claude-sonnet-4",
  systemMessage: "You are a CTO.",
};
const pm: ExpertSpec = {
  id: "01HZ-pm",
  slug: "pm",
  displayName: "PM",
  model: "claude-sonnet-4",
  systemMessage: "You are a PM.",
};

const FREEFORM_2R: DebateConfig = {
  maxRounds: 2,
  maxWordsPerResponse: 50,
  mode: "freeform",
};

async function collect(stream: AsyncIterable<DebateEvent>): Promise<DebateEvent[]> {
  const out: DebateEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

describe("DebatePersister", () => {
  let dir: string;
  let db: CouncilDatabase;
  let panelRepo: PanelRepository;
  let expertRepo: ExpertRepository;
  let debateRepo: DebateRepository;
  let turnRepo: TurnRepository;
  let panelId: string;
  let expertSlugToId: Record<string, string>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-persister-"));
    db = await createDatabase(path.join(dir, "council.db"));
    panelRepo = new PanelRepository(db);
    expertRepo = new ExpertRepository(db);
    debateRepo = new DebateRepository(db);
    turnRepo = new TurnRepository(db);

    const panel = await panelRepo.create({
      name: "test-panel",
      copilotHome: path.join(dir, "copilot"),
      configJson: "{}",
    });
    panelId = panel.id;

    // Persist experts so turn.expertId FK constraint is satisfied.
    const ctoRow = await expertRepo.create({
      panelId,
      slug: cto.slug,
      displayName: cto.displayName,
      model: cto.model,
      systemMessage: cto.systemMessage,
    });
    const pmRow = await expertRepo.create({
      panelId,
      slug: pm.slug,
      displayName: pm.displayName,
      model: pm.model,
      systemMessage: pm.systemMessage,
    });
    expertSlugToId = { [cto.slug]: ctoRow.id, [pm.slug]: pmRow.id };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.destroy();
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  async function runDebate(prompt = "topic"): Promise<{ events: DebateEvent[]; debateId: string }> {
    const engine = new MockEngine({
      responses: { [cto.id]: "CTO says go.", [pm.id]: "PM says wait." },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);

    const persister = new DebatePersister({
      debates: debateRepo,
      turns: turnRepo,
      panelId,
      expertSlugToId,
      moderator: "round-robin",
    });

    const events = await collect(
      persister.persist(new Debate(engine, [cto, pm], FREEFORM_2R).run(prompt), prompt),
    );

    // Persister should expose the created debateId after persist starts.
    expect(persister.debateId).toBeDefined();
    return { events, debateId: persister.debateId ?? "" };
  }

  it("creates a debate row before the first event is yielded", async () => {
    const { debateId } = await runDebate("Should we ship?");
    const debate = await debateRepo.findById(debateId);
    expect(debate).toBeDefined();
    expect(debate?.panelId).toBe(panelId);
    expect(debate?.prompt).toBe("Should we ship?");
    expect(debate?.moderator).toBe("round-robin");
  });

  it("transitions debate status to 'completed' on debate.end", async () => {
    const { debateId } = await runDebate();
    const debate = await debateRepo.findById(debateId);
    expect(debate?.status).toBe("completed");
    expect(debate?.endedAt).not.toBeNull();
  });

  it("flushes partial streamed content and marks the debate interrupted when the signal aborts mid-turn", async () => {
    const controller = new AbortController();
    const persister = new DebatePersister({
      debates: debateRepo,
      turns: turnRepo,
      panelId,
      expertSlugToId,
      moderator: "round-robin",
      signal: controller.signal,
    });

    async function* partialSource(): AsyncIterable<DebateEvent> {
      yield { kind: "panel.assembled", experts: [] };
      yield { kind: "round.start", round: 0 };
      yield { kind: "turn.start", expertSlug: cto.slug, round: 0, seq: 0 };
      yield { kind: "turn.delta", expertSlug: cto.slug, text: "Partial answer. " };
      controller.abort();
      yield { kind: "debate.end", reason: "aborted" };
    }

    await collect(persister.persist(partialSource(), "topic"));

    const debate = await debateRepo.findById(persister.debateId ?? "");
    expect(debate?.status).toBe("interrupted");
    expect(debate?.endedAt).not.toBeNull();

    const turns = await turnRepo.findByDebateId(persister.debateId ?? "");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      round: 0,
      seq: 0,
      expertId: expertSlugToId[cto.slug],
      content: "Partial answer. ",
      speakerKind: "expert",
    });
  });

  it("retries interrupted partial-turn persistence during abrupt-exit finalization when the first flush write fails", async () => {
    const controller = new AbortController();
    const persister = new DebatePersister({
      debates: debateRepo,
      turns: turnRepo,
      panelId,
      expertSlugToId,
      moderator: "round-robin",
      signal: controller.signal,
    });
    const originalCreate = turnRepo.create.bind(turnRepo);
    const createSpy = vi
      .spyOn(turnRepo, "create")
      .mockImplementationOnce(async () => {
        throw new Error("disk full");
      })
      .mockImplementation(async (turn: Parameters<TurnRepository["create"]>[0]) => originalCreate(turn));

    async function* partialSource(): AsyncIterable<DebateEvent> {
      yield { kind: "panel.assembled", experts: [] };
      yield { kind: "round.start", round: 0 };
      yield { kind: "turn.start", expertSlug: cto.slug, round: 0, seq: 0 };
      yield { kind: "turn.delta", expertSlug: cto.slug, text: "Partial answer. " };
      controller.abort();
      yield { kind: "debate.end", reason: "aborted" };
    }

    await expect(collect(persister.persist(partialSource(), "topic"))).rejects.toThrow("disk full");
    expect(createSpy).toHaveBeenCalledTimes(2);

    const debate = await debateRepo.findById(persister.debateId ?? "");
    expect(debate?.status).toBe("interrupted");
    const turns = await turnRepo.findByDebateId(persister.debateId ?? "");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.content).toBe("Partial answer. ");
  });

  it("warns when interrupted abrupt-exit finalization fails", async () => {
    const controller = new AbortController();
    const logger = { warn: vi.fn() };
    const persister = new DebatePersister({
      debates: debateRepo,
      turns: turnRepo,
      panelId,
      expertSlugToId,
      moderator: "round-robin",
      signal: controller.signal,
      logger,
    });
    vi.spyOn(debateRepo, "update").mockRejectedValue(new Error("update failed"));

    async function* brokenSource(): AsyncIterable<DebateEvent> {
      yield { kind: "panel.assembled", experts: [] };
      yield { kind: "round.start", round: 0 };
      yield { kind: "turn.start", expertSlug: cto.slug, round: 0, seq: 0 };
      yield { kind: "turn.delta", expertSlug: cto.slug, text: "Partial answer. " };
      controller.abort();
      throw new Error("source failed");
    }

    await expect(collect(persister.persist(brokenSource(), "topic"))).rejects.toThrow("source failed");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("finalizeAbruptExit failed"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("update failed"));
  });

  it("preserves speakerKind='human' when flushing an interrupted partial turn", async () => {
    const controller = new AbortController();
    const persister = new DebatePersister({
      debates: debateRepo,
      turns: turnRepo,
      panelId,
      expertSlugToId,
      moderator: "round-robin",
      signal: controller.signal,
    });

    async function* partialSource(): AsyncIterable<DebateEvent> {
      yield { kind: "panel.assembled", experts: [] };
      yield { kind: "round.start", round: 0 };
      yield { kind: "turn.start", expertSlug: cto.slug, round: 0, seq: 0, speakerKind: "human" };
      yield { kind: "turn.delta", expertSlug: cto.slug, text: "Human partial.", speakerKind: "human" };
      controller.abort();
      yield { kind: "debate.end", reason: "aborted" };
    }

    await collect(persister.persist(partialSource(), "topic"));

    const turns = await turnRepo.findByDebateId(persister.debateId ?? "");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.speakerKind).toBe("human");
  });

  it("inserts one turn row per turn.end event", async () => {
    const { debateId } = await runDebate();
    const turns = await turnRepo.findByDebateId(debateId);
    // 2 experts × 2 rounds = 4 turns.
    expect(turns).toHaveLength(4);
  });

  it("turn rows have correct round, seq, expertId, content, and speakerKind", async () => {
    const { debateId } = await runDebate();
    const turns = await turnRepo.findByDebateId(debateId);
    expect(turns[0]).toMatchObject({
      debateId,
      round: 0,
      seq: 0,
      expertId: expertSlugToId[cto.slug],
      content: "CTO says go.",
      speakerKind: "expert",
    });
    expect(turns[1]).toMatchObject({
      round: 0,
      seq: 1,
      expertId: expertSlugToId[pm.slug],
      content: "PM says wait.",
    });
    expect(turns[2]?.round).toBe(1);
    expect(turns[3]?.round).toBe(1);
  });

  it("yields every source event unchanged (passthrough)", async () => {
    const { events } = await runDebate();
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("panel.assembled");
    expect(kinds).toContain("round.start");
    expect(kinds).toContain("turn.start");
    expect(kinds).toContain("turn.end");
    expect(kinds[kinds.length - 1]).toBe("debate.end");
  });

  it("does NOT insert a turn row for failed turns (turn.end is not emitted on error)", async () => {
    const engine = new MockEngine({
      responses: { [cto.id]: "CTO ok." },
      failures: { [pm.id]: { code: "RATE_LIMITED", message: "throttled" } },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);

    const persister = new DebatePersister({
      debates: debateRepo,
      turns: turnRepo,
      panelId,
      expertSlugToId,
      moderator: "round-robin",
    });

    await collect(
      persister.persist(new Debate(engine, [cto, pm], FREEFORM_2R).run("topic"), "topic"),
    );

    const turns = await turnRepo.findByDebateId(persister.debateId ?? "");
    // CTO succeeds twice, PM fails twice → 2 turns persisted.
    expect(turns).toHaveLength(2);
    for (const t of turns) {
      expect(t.expertId).toBe(expertSlugToId[cto.slug]);
    }
  });

  it("ignores turn.end events for unknown expert slugs (graceful)", async () => {
    const engine = new MockEngine({
      responses: { [cto.id]: "CTO.", [pm.id]: "PM." },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);

    // Map only CTO; PM's turn.end events should be silently skipped (no FK error).
    const persister = new DebatePersister({
      debates: debateRepo,
      turns: turnRepo,
      panelId,
      expertSlugToId: { [cto.slug]: expertSlugToId[cto.slug] ?? "" },
      moderator: "round-robin",
    });

    await collect(
      persister.persist(new Debate(engine, [cto, pm], FREEFORM_2R).run("topic"), "topic"),
    );

    const turns = await turnRepo.findByDebateId(persister.debateId ?? "");
    expect(turns).toHaveLength(2);
    for (const t of turns) {
      expect(t.expertId).toBe(expertSlugToId[cto.slug]);
    }
  });
});
