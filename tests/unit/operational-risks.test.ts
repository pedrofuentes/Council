/**
 * Operational risk batch — tests for #117, #142, #143.
 *
 * RED at this commit:
 * - #143: MockEngine + CopilotEngine don't expose lastStopErrors; failing
 *   disconnects are silently swallowed during stop().
 * - #142: convene's Promise.all(addExpert) leaks created sessions when one
 *   addExpert rejects; no removeExpert cleanup.
 * - #117: DebatePersister.persist() doesn't self-finalize on stream throw
 *   or consumer break — debate row stays at status='running'.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Debate, type DebateConfig } from "../../src/core/debate.js";
import type { DebateEvent } from "../../src/core/types.js";
import type { ExpertSpec } from "../../src/engine/index.js";
import { MockEngine } from "../../src/engine/mock/mock-engine.js";

import { createDatabase, type CouncilDatabase } from "../../src/memory/db.js";
import { DebateRepository } from "../../src/memory/repositories/debates.js";
import { ExpertRepository } from "../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../src/memory/repositories/panels.js";
import { TurnRepository } from "../../src/memory/repositories/turns.js";
import { DebatePersister } from "../../src/memory/persister.js";

import { buildConveneCommand } from "../../src/cli/commands/convene.js";

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
const designer: ExpertSpec = {
  id: "01HZ-designer",
  slug: "designer",
  displayName: "Designer",
  model: "claude-sonnet-4",
  systemMessage: "You are a Designer.",
};

// ────────────────────────────────────────────────────────────────────────
// #143 — MockEngine.stop() aggregates per-session disconnect errors via
//        a `lastStopErrors` getter (read-after-stop). CopilotEngine has
//        the same getter. Backwards-compatible: stop() still returns void.
// ────────────────────────────────────────────────────────────────────────

describe("MockEngine #143 — disconnect-error aggregation via lastStopErrors", () => {
  it("exposes empty lastStopErrors after a clean stop()", async () => {
    const engine = new MockEngine();
    await engine.start();
    await engine.addExpert(cto);
    await engine.stop();
    expect(engine.lastStopErrors).toEqual([]);
  });

  it("collects per-expert disconnect failures via failOnDisconnect option", async () => {
    const engine = new MockEngine({
      failOnDisconnect: new Set([pm.id]),
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);
    await engine.addExpert(designer);
    await engine.stop();
    // Stop still completes for the others; only PM's disconnect fails.
    expect(engine.lastStopErrors).toHaveLength(1);
    const err = engine.lastStopErrors[0];
    expect(err?.message).toMatch(/01HZ-pm|disconnect/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// #142 — convene must not leak created sessions when one addExpert rejects.
//        Uses MockEngine's failOnAddExpert.afterN test seam.
// ────────────────────────────────────────────────────────────────────────

describe("convene #142 — leak-safe parallel addExpert", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-leak-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  it("when 3rd addExpert rejects, removes the 2 successfully-created experts before stop", async () => {
    // The mock engine for this test is created by the factory and
    // captured so we can inspect it after the action throws.
    let capturedEngine: MockEngine | undefined;
    const cmd = buildConveneCommand({
      engineFactory: () => {
        const e = new MockEngine({
          failOnAddExpert: { afterN: 2 }, // 1st & 2nd succeed, 3rd throws
        });
        capturedEngine = e;
        return e;
      },
      write: () => undefined,
      writeError: () => undefined,
    });
    cmd.exitOverride();

    let thrown: unknown;
    try {
      await cmd.parseAsync([
        "node",
        "council-convene",
        "Topic",
        "--template",
        "code-review",
        "--engine",
        "mock",
        "--max-rounds",
        "1",
      ]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(String(thrown)).toMatch(/could not register|addExpert|register all/i);

    // After cleanup: the 2 successfully-created experts must have been
    // removed before stop(). Engine should be in a clean state with
    // zero registered experts.
    expect(capturedEngine).toBeDefined();
    expect(capturedEngine?.expertCount).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// #117 — DebatePersister self-finalizes on abnormal exit (source throw,
//        consumer break) by marking debate.status='aborted' + endedAt.
// ────────────────────────────────────────────────────────────────────────

describe("DebatePersister #117 — self-finalize on abnormal exit", () => {
  let dir: string;
  let db: CouncilDatabase;
  let panelRepo: PanelRepository;
  let expertRepo: ExpertRepository;
  let debateRepo: DebateRepository;
  let turnRepo: TurnRepository;
  let panelId: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-persister-abort-"));
    db = await createDatabase(path.join(dir, "council.db"));
    panelRepo = new PanelRepository(db);
    expertRepo = new ExpertRepository(db);
    debateRepo = new DebateRepository(db);
    turnRepo = new TurnRepository(db);
    const panel = await panelRepo.create({
      name: "p",
      copilotHome: path.join(dir, "copilot"),
      configJson: "{}",
    });
    panelId = panel.id;
    await expertRepo.create({
      panelId,
      slug: cto.slug,
      displayName: cto.displayName,
      model: cto.model,
      systemMessage: cto.systemMessage,
    });
  });

  afterEach(async () => {
    await db.destroy();
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  function makePersister(): DebatePersister {
    return new DebatePersister({
      debates: debateRepo,
      turns: turnRepo,
      panelId,
      expertSlugToId: {},
      moderator: "round-robin",
    });
  }

  it("marks debate status='aborted' when source stream throws mid-iteration", async () => {
    const persister = makePersister();
    async function* throwingSource(): AsyncIterable<DebateEvent> {
      yield { kind: "panel.assembled", experts: [] };
      throw new Error("source failed");
    }

    let caught: unknown;
    try {
      for await (const _ of persister.persist(throwingSource(), "topic")) {
        /* drain */
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const debate = await debateRepo.findById(persister.debateId ?? "");
    expect(debate?.status).toBe("aborted");
    expect(debate?.endedAt).not.toBeNull();
  });

  it("marks debate status='aborted' when consumer breaks the loop early", async () => {
    const persister = makePersister();
    async function* longSource(): AsyncIterable<DebateEvent> {
      yield { kind: "panel.assembled", experts: [] };
      yield { kind: "round.start", round: 0 };
      yield { kind: "round.end", round: 0 };
      yield { kind: "debate.end", reason: "completed" };
    }
    for await (const _ of persister.persist(longSource(), "topic")) {
      // Consumer breaks after the first event.
      break;
    }
    const debate = await debateRepo.findById(persister.debateId ?? "");
    expect(debate?.status).toBe("aborted");
    expect(debate?.endedAt).not.toBeNull();
  });

  it("regression — normal completion still produces status='completed'", async () => {
    const persister = makePersister();
    const engine = new MockEngine({ responses: { [cto.id]: "x" } });
    await engine.start();
    await engine.addExpert(cto);

    const config: DebateConfig = {
      maxRounds: 1,
      maxWordsPerResponse: 50,
      mode: "freeform",
    };

    for await (const _ of persister.persist(
      new Debate(engine, [cto], config).run("t"),
      "t",
    )) {
      /* drain */
    }
    const debate = await debateRepo.findById(persister.debateId ?? "");
    expect(debate?.status).toBe("completed");
  });
});
