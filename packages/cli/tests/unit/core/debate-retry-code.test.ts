/**
 * Regression tests for #674: friendly retry mapping must match emitted
 * runtime values. `turn.retry` must carry a STABLE `reasonCode`
 * (EngineErrorCode) — not just the raw provider message — so renderers can
 * map it to friendly text. Previously only `reason: lastErrorMessage` was
 * emitted, so FRIENDLY_REASONS (keyed by codes) never matched real paths.
 */
import { describe, expect, it } from "vitest";

import { Debate, type DebateConfig } from "../../../src/core/debate.js";
import type { DebateEvent } from "../../../src/core/types.js";
import type { ExpertSpec } from "../../../src/engine/index.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";

const cto: ExpertSpec = {
  id: "01HZ-cto",
  slug: "cto",
  displayName: "CTO",
  model: "claude-sonnet-4",
  systemMessage: "You are a CTO.",
};

const FREEFORM_1R: DebateConfig = {
  maxRounds: 1,
  maxWordsPerResponse: 50,
  mode: "freeform",
  retryBackoffMs: [1, 2],
};

async function collect(stream: AsyncIterable<DebateEvent>): Promise<DebateEvent[]> {
  const out: DebateEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

describe("Debate retry — stable reasonCode threading (#674)", () => {
  it("turn.retry carries the engine reasonCode for RATE_LIMITED failures", async () => {
    const engine = new MockEngine({
      responses: { [cto.id]: "ok" },
      failOnSend: { expertId: cto.id, afterN: 0, failures: 1, code: "RATE_LIMITED", message: "throttled" },
    });
    await engine.start();
    await engine.addExpert(cto);

    const events = await collect(new Debate(engine, [cto], FREEFORM_1R).run("topic"));
    const retry = events.find((e) => e.kind === "turn.retry") as
      | { kind: "turn.retry"; reasonCode?: string; reason: string }
      | undefined;
    expect(retry).toBeDefined();
    expect(retry?.reasonCode).toBe("RATE_LIMITED");
  });

  it("turn.retry carries the engine reasonCode for NETWORK failures", async () => {
    const engine = new MockEngine({
      responses: { [cto.id]: "ok" },
      failOnSend: { expertId: cto.id, afterN: 0, failures: 1, code: "NETWORK", message: "connection reset" },
    });
    await engine.start();
    await engine.addExpert(cto);

    const events = await collect(new Debate(engine, [cto], FREEFORM_1R).run("topic"));
    const retry = events.find((e) => e.kind === "turn.retry") as
      | { kind: "turn.retry"; reasonCode?: string }
      | undefined;
    expect(retry?.reasonCode).toBe("NETWORK");
  });
});
