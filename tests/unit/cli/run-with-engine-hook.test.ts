/**
 * RED — runWithEngine must invoke an optional post-debate hook
 * (`onDebateComplete`) after the renderer finishes streaming and
 * BEFORE the engine is stopped. The hook receives the live engine
 * (still running, so it can register a temporary extractor expert),
 * the debate id (for turn lookup), and the slug→id map.
 *
 * Contracts:
 *   1. Hook is invoked exactly once on a successful debate.
 *   2. Hook is invoked with the engine still running (engine.stop has
 *      not been called yet) — verified by checking the mock engine's
 *      stop-call counter at hook-call time.
 *   3. Hook errors must NOT bubble out of runWithEngine; the debate
 *      succeeded and cleanup (engine.stop) must still happen.
 *   4. Hook is NOT called when the debate itself threw before the
 *      renderer finished (i.e. on engine errors).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWithEngine } from "../../../src/cli/run-with-engine.js";
import type { DebateEvent } from "../../../src/core/types.js";
import type { CouncilEngine, ExpertSpec } from "../../../src/engine/index.js";
import { DebatePersister } from "../../../src/memory/persister.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";
import { createDatabase, type CouncilDatabase } from "../../../src/memory/db.js";
import { PanelRepository } from "../../../src/memory/repositories/panels.js";
import { ExpertRepository } from "../../../src/memory/repositories/experts.js";

const expert: ExpertSpec = {
  id: "placeholder",
  slug: "cto",
  displayName: "CTO",
  model: "claude-sonnet-4",
  systemMessage: "You are a CTO.",
};

describe("runWithEngine — onDebateComplete post-debate hook", () => {
  let dir: string;
  let db: CouncilDatabase;
  let panelId: string;
  let expertSlugToId: Record<string, string>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-hook-"));
    db = await createDatabase(path.join(dir, "council.db"));
    const panel = await new PanelRepository(db).create({
      name: "p",
      copilotHome: path.join(dir, "copilot"),
      configJson: "{}",
    });
    panelId = panel.id;
    const e = await new ExpertRepository(db).create({
      panelId,
      slug: expert.slug,
      displayName: expert.displayName,
      model: expert.model,
      systemMessage: expert.systemMessage,
    });
    expertSlugToId = { [expert.slug]: e.id };
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

  it("calls onDebateComplete once with the live engine + debateId after a successful debate", async () => {
    let captured: {
      engine: CouncilEngine;
      debateId: string;
      stopCalledBeforeHook: boolean;
    } | undefined;
    let stopCalls = 0;
    const mock = new MockEngine();
    const origStop = mock.stop.bind(mock);
    mock.stop = async () => {
      stopCalls += 1;
      return origStop();
    };

    await runWithEngine({
      engineKind: "mock",
      engineFactory: () => mock,
      experts: [{ ...expert, id: (expertSlugToId[expert.slug] ?? "") }],
      debateConfig: { maxRounds: 1, maxWordsPerResponse: 50, mode: "freeform" },
      prompt: "Topic",
      panelId,
      expertSlugToId,
      moderator: "round-robin",
      format: "plain",
      write: () => undefined,
      writeError: () => undefined,
      db,
      onDebateComplete: async (ctx) => {
        captured = {
          engine: ctx.engine,
          debateId: ctx.debateId,
          stopCalledBeforeHook: stopCalls > 0,
        };
      },
    });

    expect(captured).toBeDefined();
    expect(captured?.engine).toBe(mock);
    expect(typeof captured?.debateId).toBe("string");
    expect(captured?.debateId.length).toBeGreaterThan(0);
    expect(captured?.stopCalledBeforeHook).toBe(false);
    // engine.stop must still have run exactly once after the hook.
    expect(stopCalls).toBe(1);
  });

  it("swallows hook errors and still stops the engine", async () => {
    const mock = new MockEngine();
    let stopped = false;
    const origStop = mock.stop.bind(mock);
    mock.stop = async () => {
      stopped = true;
      return origStop();
    };

    await expect(
      runWithEngine({
        engineKind: "mock",
        engineFactory: () => mock,
        experts: [{ ...expert, id: (expertSlugToId[expert.slug] ?? "") }],
        debateConfig: { maxRounds: 1, maxWordsPerResponse: 50, mode: "freeform" },
        prompt: "Topic",
        panelId,
        expertSlugToId,
        moderator: "round-robin",
        format: "plain",
        write: () => undefined,
        writeError: () => undefined,
        db,
        onDebateComplete: async () => {
          throw new Error("hook boom");
        },
      }),
    ).resolves.toBeUndefined();
    expect(stopped).toBe(true);
  });

  it("injects a DebatePersister logger that writes warnings to stderr", async () => {
    let errored = "";
    let capturedLogger: { warn(message: string): void } | undefined;
    const persistSpy = vi
      .spyOn(DebatePersister.prototype, "persist")
      .mockImplementation(function (this: DebatePersister): AsyncIterable<DebateEvent> {
        capturedLogger = (this as unknown as { deps: { logger?: { warn(message: string): void } } }).deps
          .logger;
        return (async function* (): AsyncGenerator<DebateEvent, void, void> {
          yield { kind: "panel.assembled", experts: [] };
          yield { kind: "debate.end", reason: "completed" };
        })();
      });

    await runWithEngine({
      engineKind: "mock",
      engineFactory: () => new MockEngine(),
      experts: [{ ...expert, id: (expertSlugToId[expert.slug] ?? "") }],
      debateConfig: { maxRounds: 1, maxWordsPerResponse: 50, mode: "freeform" },
      prompt: "Topic",
      panelId,
      expertSlugToId,
      moderator: "round-robin",
      format: "json",
      write: () => undefined,
      writeError: (s) => {
        errored += s;
      },
      db,
    });

    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(capturedLogger).toBeDefined();
    capturedLogger?.warn("finalize failed");
    expect(errored).toContain("finalize failed");
  });
});
