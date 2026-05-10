/**
 * Tests for retry-on-recoverable-error in `Debate.#runTurn` (ROADMAP §3.7).
 *
 * Behavior:
 *   - When `engine.send()` yields an `error` event with `recoverable:
 *     true` (RATE_LIMITED, NETWORK), the orchestrator retries the
 *     turn up to MAX_RETRIES times with exponential backoff (250ms,
 *     1000ms).
 *   - Each retry attempt emits a `turn.retry` event with the attempt
 *     count + reason for renderers to surface progress.
 *   - On retry exhaustion: emits a final `error` event and proceeds
 *     to the next turn (does NOT terminate the debate).
 *   - Non-recoverable errors (NOT_AUTHENTICATED, MODEL_UNAVAILABLE, etc.)
 *     do NOT retry — fail fast.
 *
 * RED at this commit: no retry logic in src/core/debate.ts; no
 * `turn.retry` variant in DebateEvent.
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
  // Tighten backoff for tests so they run fast (max 2 retries × 2ms ~= 4ms total).
  retryBackoffMs: [1, 2],
};

async function collect(stream: AsyncIterable<DebateEvent>): Promise<DebateEvent[]> {
  const out: DebateEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

describe("Debate retry — recoverable errors retry up to 2× with backoff (#3.7)", () => {
  it("succeeds on the third attempt after two RATE_LIMITED failures", async () => {
    // MockEngine fails RATE_LIMITED on attempt 1 + 2, succeeds on 3.
    // Uses the new failOnSend.afterN test seam (analogous to
    // failOnAddExpert.afterN — fails 1..N then succeeds).
    const engine = new MockEngine({
      responses: { [cto.id]: "CTO ultimately succeeded." },
      failOnSend: {
        expertId: cto.id,
        afterN: 0, // 1st & 2nd send fail; 3rd onwards succeeds
        failures: 2,
        code: "RATE_LIMITED",
        message: "throttled",
      },
    });
    await engine.start();
    await engine.addExpert(cto);

    const events = await collect(new Debate(engine, [cto], FREEFORM_1R).run("topic"));

    // 2 retries → 2 turn.retry events
    const retries = events.filter((e) => e.kind === "turn.retry");
    expect(retries).toHaveLength(2);
    // Final turn.end with the success content
    const turnEnds = events.filter((e) => e.kind === "turn.end");
    expect(turnEnds).toHaveLength(1);
    expect((turnEnds[0] as { content: string }).content).toBe("CTO ultimately succeeded.");
    // No final error event for this expert
    const errors = events.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(0);
  });

  it("after 2 retries exhausted, emits final error and continues debate", async () => {
    // 3 failures total — exhausts the 2 retries. With max 2 retries
    // the orchestrator makes 3 total attempts (initial + 2 retries).
    const engine = new MockEngine({
      responses: { [cto.id]: "should never be reached" },
      failOnSend: {
        expertId: cto.id,
        afterN: 0,
        failures: 99, // always fail
        code: "RATE_LIMITED",
        message: "still throttled",
      },
    });
    await engine.start();
    await engine.addExpert(cto);

    const events = await collect(new Debate(engine, [cto], FREEFORM_1R).run("topic"));

    // 2 retry events
    const retries = events.filter((e) => e.kind === "turn.retry");
    expect(retries).toHaveLength(2);
    // No turn.end (failed)
    expect(events.filter((e) => e.kind === "turn.end")).toHaveLength(0);
    // Exactly one final error
    const errors = events.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    // Debate still ends normally (failed-turn doesn't terminate)
    const endEvents = events.filter((e) => e.kind === "debate.end");
    expect(endEvents).toHaveLength(1);
    expect((endEvents[0] as { reason: string }).reason).toBe("completed");
  });

  it("non-recoverable errors (NOT_AUTHENTICATED) do NOT retry — fail fast", async () => {
    const engine = new MockEngine({
      responses: { [cto.id]: "should never be reached" },
      failOnSend: {
        expertId: cto.id,
        afterN: 0,
        failures: 99,
        code: "NOT_AUTHENTICATED",
        message: "auth required",
      },
    });
    await engine.start();
    await engine.addExpert(cto);

    const events = await collect(new Debate(engine, [cto], FREEFORM_1R).run("topic"));

    // No retries
    expect(events.filter((e) => e.kind === "turn.retry")).toHaveLength(0);
    // One error
    const errors = events.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    // Error is marked non-recoverable
    expect((errors[0] as { recoverable: boolean }).recoverable).toBe(false);
  });

  it("turn.retry event carries attempt number and reason", async () => {
    const engine = new MockEngine({
      responses: { [cto.id]: "ok" },
      failOnSend: {
        expertId: cto.id,
        afterN: 0,
        failures: 1, // fail once, succeed on retry
        code: "NETWORK",
        message: "connection reset",
      },
    });
    await engine.start();
    await engine.addExpert(cto);

    const events = await collect(new Debate(engine, [cto], FREEFORM_1R).run("topic"));
    const retry = events.find((e) => e.kind === "turn.retry") as
      | { kind: "turn.retry"; attempt: number; reason: string; expertSlug: string }
      | undefined;
    expect(retry).toBeDefined();
    expect(retry?.attempt).toBe(1); // 1st retry (i.e. 2nd total attempt)
    expect(retry?.expertSlug).toBe(cto.slug);
    expect(retry?.reason.toLowerCase()).toMatch(/network|connection|recoverable/);
  });
});
