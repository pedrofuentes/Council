/**
 * Regression tests for #114: the terminal `error` DebateEvent must carry a
 * machine-readable `code` (EngineErrorCode) — not just the human `message` —
 * so downstream consumers (exit-code mapping, renderers, telemetry) can react
 * to the failure class without brittle message string-matching.
 *
 * The orchestrator already knows the driving code (`lastErrorCode`) at the
 * emit site — it threads it into `turn.retry` as `reasonCode` (#674) but,
 * before this fix, dropped it from the terminal `error` event.
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

type ErrorEvent = Extract<DebateEvent, { kind: "error" }>;

describe("Debate terminal error — machine-readable code threading (#114)", () => {
  it("carries the engine code on a NON-recoverable terminal error", async () => {
    // MODEL_UNAVAILABLE is non-recoverable → one failure, no retry, straight
    // to the terminal error emit with lastErrorCode still in scope.
    const engine = new MockEngine({
      responses: { [cto.id]: "ok" },
      failOnSend: {
        expertId: cto.id,
        afterN: 0,
        failures: 1,
        code: "MODEL_UNAVAILABLE",
        message: "model down",
      },
    });
    await engine.start();
    await engine.addExpert(cto);

    const events = await collect(new Debate(engine, [cto], FREEFORM_1R).run("topic"));
    const error = events.find((e): e is ErrorEvent => e.kind === "error");
    expect(error).toBeDefined();
    expect(error?.code).toBe("MODEL_UNAVAILABLE");
    expect(error?.recoverable).toBe(false);
  });

  it("carries the engine code when a recoverable error EXHAUSTS retries", async () => {
    // retryBackoffMs [1, 2] → 3 total sends. All three fail recoverably
    // (RATE_LIMITED) → retries exhausted → terminal error still carries the
    // driving code so consumers see it was a throttle, not a hard failure.
    const engine = new MockEngine({
      responses: { [cto.id]: "ok" },
      failOnSend: {
        expertId: cto.id,
        afterN: 0,
        failures: 3,
        code: "RATE_LIMITED",
        message: "throttled",
      },
    });
    await engine.start();
    await engine.addExpert(cto);

    const events = await collect(new Debate(engine, [cto], FREEFORM_1R).run("topic"));
    const error = events.find((e): e is ErrorEvent => e.kind === "error");
    expect(error).toBeDefined();
    expect(error?.code).toBe("RATE_LIMITED");
    expect(error?.recoverable).toBe(true);
  });
});
