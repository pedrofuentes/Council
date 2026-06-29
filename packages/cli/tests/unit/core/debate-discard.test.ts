/**
 * Tests for failed-attempt delta discard before retry (#184).
 *
 * When an AI turn fails partway through after emitting some `turn.delta`s
 * and the orchestrator retries on a recoverable error, those partial deltas
 * have ALREADY been forwarded to renderers. The fix emits a `turn.discard`
 * event before `turn.retry` so consumers drop the failed attempt's content
 * before the retry's fresh deltas arrive.
 */
import { describe, expect, it } from "vitest";

import { Debate, type DebateConfig } from "../../../src/core/debate.js";
import type { CouncilEngine, ExpertSpec } from "../../../src/engine/index.js";
import type { DebateEvent } from "../../../src/core/types.js";
import type { EngineEvent, SendOptions } from "../../../src/engine/types.js";

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

/** Engine that emits partial deltas then a recoverable error on send #1, succeeds on #2. */
class PartialThenRetryEngine implements CouncilEngine {
  #sends = 0;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async addExpert(): Promise<void> {}
  async removeExpert(): Promise<void> {}
  send(options: SendOptions): AsyncIterable<EngineEvent> {
    this.#sends += 1;
    const first = this.#sends === 1;
    return (async function* (): AsyncGenerator<EngineEvent> {
      if (first) {
        yield { kind: "message.delta", expertId: options.expertId, text: "FAILED PARTIAL" };
        yield {
          kind: "error",
          expertId: options.expertId,
          error: { code: "RATE_LIMITED", message: "throttled", provider: "mock" },
          recoverable: true,
        };
        return;
      }
      yield { kind: "message.delta", expertId: options.expertId, text: "good answer" };
      yield {
        kind: "message.complete",
        expertId: options.expertId,
        response: { latencyMs: 1, tokensIn: 1, tokensOut: 1 },
      };
    })();
  }
}

async function collect(stream: AsyncIterable<DebateEvent>): Promise<DebateEvent[]> {
  const out: DebateEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

describe("Debate turn.discard before retry (#184)", () => {
  it("emits turn.discard before turn.retry once partial deltas were forwarded", async () => {
    const events = await collect(new Debate(new PartialThenRetryEngine(), [cto], FREEFORM_1R).run("topic"));

    const discardIdx = events.findIndex((e) => e.kind === "turn.discard");
    const retryIdx = events.findIndex((e) => e.kind === "turn.retry");
    expect(discardIdx).toBeGreaterThanOrEqual(0);
    expect(retryIdx).toBeGreaterThanOrEqual(0);
    expect(discardIdx).toBeLessThan(retryIdx);

    const discard = events[discardIdx];
    if (discard?.kind === "turn.discard") {
      expect(discard.expertSlug).toBe("cto");
    }

    // The failed partial delta must precede the discard, retry deltas after.
    const order = events
      .filter((e) => e.kind === "turn.delta" || e.kind === "turn.discard")
      .map((e) => (e.kind === "turn.delta" ? e.text : "<discard>"));
    expect(order).toContain("FAILED PARTIAL");
    expect(order.indexOf("FAILED PARTIAL")).toBeLessThan(order.indexOf("<discard>"));
    expect(order.indexOf("<discard>")).toBeLessThan(order.indexOf("good answer"));

    const turnEnd = events.find((e) => e.kind === "turn.end");
    expect(turnEnd && turnEnd.kind === "turn.end" ? turnEnd.content : "").toBe("good answer");
  });
});
