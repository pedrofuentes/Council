/**
 * Tests for #150 + #151 — correctness fixes from PR #147 Sentinel cycle.
 *
 * #150: DebatePersister must NOT silently overwrite the debate row to
 *       status='aborted' when the terminal debate.end update itself
 *       throws. Original error must bubble; row state stays truthful.
 *
 * #151: convene must call removeExpert ONLY for experts whose addExpert
 *       fulfilled — not the whole experts list. Plus a contract test
 *       that MockEngine.removeExpert("unknown") is a no-op.
 *
 * RED at this commit: persister still mutates to 'aborted' on terminal
 * failure; convene still iterates all N; MockEngine has no
 * removeExpertCalls accessor.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

// ────────────────────────────────────────────────────────────────────────
// #150 — DebatePersister: terminal update failure must NOT mutate the
//        row to 'aborted'.
// ────────────────────────────────────────────────────────────────────────

describe("DebatePersister #150 — terminal update failure does not mask as aborted", () => {
  let dir: string;
  let db: CouncilDatabase;
  let panelRepo: PanelRepository;
  let debateRepo: DebateRepository;
  let turnRepo: TurnRepository;
  let panelId: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-pr150-"));
    db = await createDatabase(path.join(dir, "council.db"));
    panelRepo = new PanelRepository(db);
    debateRepo = new DebateRepository(db);
    turnRepo = new TurnRepository(db);
    const panel = await panelRepo.create({
      name: "p",
      copilotHome: path.join(dir, "copilot"),
      configJson: "{}",
    });
    panelId = panel.id;
  });

  afterEach(async () => {
    await db.destroy();
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  it("when debate.end terminal update throws, row stays at 'running' (not silently 'aborted')", async () => {
    // Wrap debateRepo.update so the terminal call throws, but the
    // create + later (finally-block) update calls go through.
    const wrappedRepo = new Proxy(debateRepo, {
      get(target, prop, receiver) {
        if (prop === "update") {
          return async (
            id: string,
            patch: { status?: string; endedAt?: string; costEstimate?: number },
          ) => {
            if (patch.status === "completed") {
              throw new Error("simulated terminal-update failure");
            }
            return Reflect.get(target, prop, receiver).call(target, id, patch);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as DebateRepository;

    const persister = new DebatePersister({
      debates: wrappedRepo,
      turns: turnRepo,
      panelId,
      expertSlugToId: {},
      moderator: "round-robin",
    });

    async function* completingSource(): AsyncIterable<DebateEvent> {
      yield { kind: "panel.assembled", experts: [] };
      yield { kind: "debate.end", reason: "completed" };
    }

    let caught: unknown;
    try {
      for await (const _ of persister.persist(completingSource(), "topic")) {
        /* drain */
      }
    } catch (err) {
      caught = err;
    }

    // The original simulated error MUST bubble to the caller.
    expect(caught).toBeDefined();
    expect(String(caught)).toMatch(/simulated terminal-update failure/);

    // The row must NOT have been overwritten to 'aborted' by the finally
    // block. The terminal update was attempted; let the row stay at its
    // pre-attempt state ('running') so the failure is honest.
    const debate = await debateRepo.findById(persister.debateId ?? "");
    expect(debate?.status).toBe("running");
    expect(debate?.endedAt).toBeNull();
  });

  it("regression — abnormal exit BEFORE any debate.end still marks aborted", async () => {
    // Make sure the #117 fix still works for the genuine abort case.
    const persister = new DebatePersister({
      debates: debateRepo,
      turns: turnRepo,
      panelId,
      expertSlugToId: {},
      moderator: "round-robin",
    });

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
});

// ────────────────────────────────────────────────────────────────────────
// #151 — convene rollback filters to fulfilled-only addExpert results.
//        MockEngine gets a removeExpertCalls test seam.
// ────────────────────────────────────────────────────────────────────────

describe("MockEngine #151 — removeExpert idempotency contract + test seam", () => {
  it("removeExpert(unknown-id) is a no-op (does not throw)", async () => {
    const engine = new MockEngine();
    await engine.start();
    await expect(engine.removeExpert("never-registered-id")).resolves.toBeUndefined();
  });

  it("exposes removeExpertCalls test accessor for verification", async () => {
    const engine = new MockEngine();
    await engine.start();
    await engine.addExpert(cto);
    await engine.removeExpert(cto.id);
    await engine.removeExpert("ghost");
    expect(engine.removeExpertCalls).toEqual([cto.id, "ghost"]);
  });
});

describe("convene #151 — rollback filters to fulfilled-only addExpert results", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-pr151-"));
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

  it("on partial-failure rollback, removeExpert is called only for the experts that registered", async () => {
    let capturedEngine: MockEngine | undefined;
    const cmd = buildConveneCommand({
      engineFactory: () => {
        const e = new MockEngine({
          // 1st addExpert succeeds; 2nd rejects.
          failOnAddExpert: { afterN: 1 },
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
    expect(capturedEngine).toBeDefined();

    // The removeExpert calls during rollback must include ONLY the
    // first expert (the only one whose addExpert fulfilled). Calling
    // removeExpert on the 2nd, 3rd, 4th, etc. is wasted work and
    // depends on an unverified idempotency contract.
    //
    // The convene flow uses code-review template which has 4 experts.
    // expert[0] fulfilled (added). expert[1] rejected (after 1).
    // expert[2..3] never resolved (Promise.allSettled doesn't reach
    // the promise — actually it does: all 4 calls are kicked off
    // concurrently). All non-first calls reject because failOnAddExpert
    // tracks call count. So only expert[0] should be in
    // removeExpertCalls.
    const calls = capturedEngine!.removeExpertCalls;
    expect(calls).toHaveLength(1);
  });
});
