/**
 * Tests for AbortSignal threading through `Debate.run()` (#503).
 *
 * Behavior:
 *   - `Debate.run(prompt, { signal })` MUST forward `signal` to every
 *     `engine.send()` invocation so a Ctrl+C upstream of the
 *     orchestrator cancels the in-flight LLM request, not just the
 *     local consumer loop.
 *   - When `signal` is already aborted before `run()` starts, the
 *     debate ends immediately with `reason: "aborted"` and never calls
 *     `engine.send()`.
 *   - Aborting between turns stops further `engine.send()` calls and
 *     ends the debate with `reason: "aborted"`.
 *   - Backwards compatible: calling `run(prompt)` without options still
 *     works for existing callers.
 */
import { describe, expect, it } from "vitest";

import { Debate, type DebateConfig } from "../../../src/core/debate.js";
import type { DebateEvent } from "../../../src/core/types.js";
import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../src/engine/index.js";

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

const FREEFORM_1R: DebateConfig = {
  maxRounds: 1,
  maxWordsPerResponse: 50,
  mode: "freeform",
};

const STRUCTURED: DebateConfig = {
  maxRounds: 1,
  maxWordsPerResponse: 50,
  mode: "structured",
};

interface RecordedSend {
  readonly expertId: string;
  readonly signal: AbortSignal | undefined;
}

/**
 * Minimal CouncilEngine that records every `send()` invocation so
 * tests can assert that `Debate.run`'s `signal` is plumbed through to
 * `SendOptions.signal`. The stream yields one delta + completes; if
 * the signal aborts mid-stream it yields a terminal ABORTED error.
 */
class RecordingEngine implements CouncilEngine {
  readonly sends: RecordedSend[] = [];

  async start(): Promise<void> {
    /* no-op */
  }
  async stop(): Promise<void> {
    /* no-op */
  }
  async addExpert(_spec: ExpertSpec): Promise<void> {
    /* no-op */
  }
  async removeExpert(_expertId: string): Promise<void> {
    /* no-op */
  }
  async listModels(): Promise<readonly string[]> {
    return ["mock"];
  }

  send(options: SendOptions): AsyncIterable<EngineEvent> {
    this.sends.push({ expertId: options.expertId, signal: options.signal });
    const expertId = options.expertId;
    const signal = options.signal;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
        if (signal?.aborted) {
          yield {
            kind: "error",
            expertId,
            error: { code: "ABORTED", message: "pre-aborted" },
            recoverable: false,
          };
          return;
        }
        yield { kind: "message.delta", expertId, text: "hello" };
        yield {
          kind: "message.complete",
          expertId,
          response: { latencyMs: 1 },
        };
      },
    };
  }
}

async function collect(stream: AsyncIterable<DebateEvent>): Promise<DebateEvent[]> {
  const out: DebateEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

describe("Debate.run() — AbortSignal threading (#503)", () => {
  it("forwards the run() signal to every engine.send() call", async () => {
    const engine = new RecordingEngine();
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);

    const controller = new AbortController();
    const debate = new Debate(engine, [cto, pm], FREEFORM_1R);
    await collect(debate.run("topic", { signal: controller.signal }));

    expect(engine.sends.length).toBe(2);
    for (const s of engine.sends) {
      expect(s.signal).toBe(controller.signal);
    }
  });

  it("stops immediately with reason 'aborted' when signal is pre-aborted", async () => {
    const engine = new RecordingEngine();
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);

    const controller = new AbortController();
    controller.abort();

    const debate = new Debate(engine, [cto, pm], FREEFORM_1R);
    const events = await collect(debate.run("topic", { signal: controller.signal }));

    expect(engine.sends.length).toBe(0);
    const last = events[events.length - 1];
    expect(last?.kind).toBe("debate.end");
    if (last?.kind === "debate.end") {
      expect(last.reason).toBe("aborted");
    }
  });

  it("stops further engine.send() calls when signal aborts mid-debate", async () => {
    const engine = new RecordingEngine();
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);

    const controller = new AbortController();
    const debate = new Debate(engine, [cto, pm], FREEFORM_1R);

    const events: DebateEvent[] = [];
    for await (const evt of debate.run("topic", { signal: controller.signal })) {
      events.push(evt);
      // Abort right after the first turn ends, before the second turn fires.
      if (evt.kind === "turn.end" && evt.expertSlug === "cto") {
        controller.abort();
      }
    }

    // Only the first expert's send() should have run.
    expect(engine.sends.map((s) => s.expertId)).toEqual([cto.id]);
    const last = events[events.length - 1];
    expect(last?.kind).toBe("debate.end");
    if (last?.kind === "debate.end") {
      expect(last.reason).toBe("aborted");
    }
  });

  it("remains backwards-compatible when called without options", async () => {
    const engine = new RecordingEngine();
    await engine.start();
    await engine.addExpert(cto);

    const debate = new Debate(engine, [cto], FREEFORM_1R);
    const events = await collect(debate.run("topic"));

    expect(engine.sends.length).toBe(1);
    expect(engine.sends[0]?.signal).toBeUndefined();
    const last = events[events.length - 1];
    expect(last?.kind).toBe("debate.end");
  });

  it("aborts an in-flight engine.send before it completes", async () => {
    class HangingEngine extends RecordingEngine {
      override send(options: SendOptions): AsyncIterable<EngineEvent> {
        this.sends.push({ expertId: options.expertId, signal: options.signal });
        const expertId = options.expertId;
        const signal = options.signal;
        return {
          async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
            yield { kind: "message.delta", expertId, text: "partial..." };
            await new Promise<void>((resolve) => {
              if (signal?.aborted) {
                resolve();
                return;
              }
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            yield {
              kind: "error",
              expertId,
              error: { code: "ABORTED", message: "aborted upstream" },
              recoverable: false,
            };
          },
        };
      }
    }

    const engine = new HangingEngine();
    await engine.start();
    await engine.addExpert(cto);

    const controller = new AbortController();
    const debate = new Debate(engine, [cto], FREEFORM_1R);
    const events: DebateEvent[] = [];
    const consumer = (async (): Promise<void> => {
      for await (const evt of debate.run("topic", { signal: controller.signal })) {
        events.push(evt);
      }
    })();

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await consumer;

    expect(engine.sends.length).toBe(1);
    expect(engine.sends[0]?.signal).toBe(controller.signal);
    const last = events[events.length - 1];
    expect(last?.kind).toBe("debate.end");
    if (last?.kind === "debate.end") {
      expect(last.reason).toBe("aborted");
    }
  });

  it("does not surface a spurious turn-level error when abort fires mid-stream", async () => {
    class HangingEngine extends RecordingEngine {
      override send(options: SendOptions): AsyncIterable<EngineEvent> {
        this.sends.push({ expertId: options.expertId, signal: options.signal });
        const expertId = options.expertId;
        const signal = options.signal;
        return {
          async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
            yield { kind: "message.delta", expertId, text: "partial" };
            await new Promise<void>((resolve) => {
              if (signal?.aborted) return resolve();
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            yield {
              kind: "error",
              expertId,
              error: { code: "ABORTED", message: "aborted upstream" },
              recoverable: false,
            };
          },
        };
      }
    }

    const engine = new HangingEngine();
    await engine.start();
    await engine.addExpert(cto);

    const controller = new AbortController();
    const debate = new Debate(engine, [cto], FREEFORM_1R);
    const events: DebateEvent[] = [];
    const consumer = (async (): Promise<void> => {
      for await (const evt of debate.run("topic", { signal: controller.signal })) {
        events.push(evt);
      }
    })();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await consumer;

    const errors = events.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(0);
  });

  it("yields debate.end 'aborted' (not 'completed') when abort fires on the final turn", async () => {
    class SlowEngine extends RecordingEngine {
      override send(options: SendOptions): AsyncIterable<EngineEvent> {
        this.sends.push({ expertId: options.expertId, signal: options.signal });
        const expertId = options.expertId;
        const signal = options.signal;
        return {
          async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
            yield { kind: "message.delta", expertId, text: "x" };
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
            if (signal?.aborted) {
              yield {
                kind: "error",
                expertId,
                error: { code: "ABORTED", message: "aborted" },
                recoverable: false,
              };
              return;
            }
            yield {
              kind: "message.complete",
              expertId,
              response: { latencyMs: 1 },
            };
          },
        };
      }
    }

    const engine = new SlowEngine();
    await engine.start();
    await engine.addExpert(cto);

    const controller = new AbortController();
    const debate = new Debate(engine, [cto], FREEFORM_1R);
    const events: DebateEvent[] = [];
    const consumer = (async (): Promise<void> => {
      for await (const evt of debate.run("topic", { signal: controller.signal })) {
        events.push(evt);
        if (evt.kind === "turn.delta") controller.abort();
      }
    })();
    await consumer;

    const ends = events.filter((e) => e.kind === "debate.end");
    expect(ends).toHaveLength(1);
    if (ends[0]?.kind === "debate.end") {
      expect(ends[0].reason).toBe("aborted");
    }
  });

  it("structured mode: abort during the final phase yields debate.end 'aborted', not 'completed'", async () => {
    class SlowEngine extends RecordingEngine {
      override send(options: SendOptions): AsyncIterable<EngineEvent> {
        this.sends.push({ expertId: options.expertId, signal: options.signal });
        const expertId = options.expertId;
        const signal = options.signal;
        return {
          async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
            yield { kind: "message.delta", expertId, text: "x" };
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
            if (signal?.aborted) {
              yield {
                kind: "error",
                expertId,
                error: { code: "ABORTED", message: "aborted" },
                recoverable: false,
              };
              return;
            }
            yield {
              kind: "message.complete",
              expertId,
              response: { latencyMs: 1 },
            };
          },
        };
      }
    }

    const engine = new SlowEngine();
    await engine.start();
    await engine.addExpert(cto);

    const controller = new AbortController();
    // Single-expert structured debate runs 3 phases (opening, rebuttal,
    // synthesis). Abort during the synthesis phase (the last one) so
    // the final-completion path is the one exercised.
    const debate = new Debate(engine, [cto], STRUCTURED);
    const events: DebateEvent[] = [];
    let phaseCount = 0;
    for await (const evt of debate.run("topic", { signal: controller.signal })) {
      events.push(evt);
      if (evt.kind === "round.start") {
        phaseCount += 1;
        if (phaseCount === 3) controller.abort();
      }
    }

    const ends = events.filter((e) => e.kind === "debate.end");
    expect(ends).toHaveLength(1);
    if (ends[0]?.kind === "debate.end") {
      expect(ends[0].reason).toBe("aborted");
    }
  });

  it("forwards the run() signal through to the LLM summarizer's engine.send", async () => {
    // Two-round freeform with LLM summarization enabled — the
    // per-round buildLLMSummary() runs at the top of round 1 (after
    // round 0 has produced prior turns). The summarizer's send MUST
    // receive the same signal as the per-turn sends.
    const engine = new RecordingEngine();
    await engine.start();
    await engine.addExpert(cto);

    const controller = new AbortController();
    const debate = new Debate(engine, [cto], {
      maxRounds: 2,
      maxWordsPerResponse: 50,
      mode: "freeform",
      contextConfig: {
        summarizer: { mode: "llm", summarizeAfterRound: 1, maxSummaryLength: 200 },
      },
    });
    await collect(debate.run("topic", { signal: controller.signal }));

    // sends include: round-0 cto turn, round-1 summarizer (temp expert),
    // and round-1 cto turn. All must carry the caller's signal.
    expect(engine.sends.length).toBeGreaterThanOrEqual(2);
    for (const s of engine.sends) {
      expect(s.signal).toBe(controller.signal);
    }
  });

  it("does NOT suppress a non-ABORTED engine error just because signal is aborted", async () => {
    // Engine yields a recoverable error (RATE_LIMITED) on the first
    // attempt. Caller's signal aborts before the retry can fire. The
    // turn-level error must still surface so the failure cause is
    // visible — suppression is reserved for ABORTED engine errors.
    class FlakyEngine extends RecordingEngine {
      callCount = 0;
      override send(options: SendOptions): AsyncIterable<EngineEvent> {
        this.sends.push({ expertId: options.expertId, signal: options.signal });
        const expertId = options.expertId;
        this.callCount += 1;
        return {
          async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
            yield {
              kind: "error",
              expertId,
              error: { code: "PROVIDER_ERROR", message: "real failure" },
              recoverable: false,
            };
          },
        };
      }
    }

    const engine = new FlakyEngine();
    await engine.start();
    await engine.addExpert(cto);

    const controller = new AbortController();
    const debate = new Debate(engine, [cto], FREEFORM_1R);
    const events: DebateEvent[] = [];
    for await (const evt of debate.run("topic", { signal: controller.signal })) {
      events.push(evt);
      // Abort right after the engine's error event has surfaced through
      // the orchestrator. The turn-level error is yielded synchronously
      // from #runAiTurn after the engine stream ends, so by the time we
      // see ANY event after turn.start, the error has been emitted.
      if (evt.kind === "turn.start") controller.abort();
    }

    const errors = events.filter((e) => e.kind === "error");
    // The non-ABORTED error MUST surface — masking it would hide a real
    // provider failure behind the abort.
    expect(errors.length).toBe(1);
    if (errors[0]?.kind === "error") {
      expect(errors[0].message).toBe("real failure");
    }
  });

  it("does NOT suppress an ABORTED engine error when the caller's signal was never aborted (engine.stop()/removeExpert path)", async () => {
    // The engine itself can yield {error.code: "ABORTED"} from
    // engine.stop() or removeExpert() — independent of the caller's
    // AbortSignal. In that case the run signal is NOT aborted, so the
    // synthetic turn-level error must still surface; otherwise the
    // failure becomes a silent null turn and the debate may end as
    // "completed".
    class EngineSideAbortEngine extends RecordingEngine {
      override send(options: SendOptions): AsyncIterable<EngineEvent> {
        this.sends.push({ expertId: options.expertId, signal: options.signal });
        const expertId = options.expertId;
        return {
          async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
            yield {
              kind: "error",
              expertId,
              error: { code: "ABORTED", message: "engine stopped" },
              recoverable: false,
            };
          },
        };
      }
    }

    const engine = new EngineSideAbortEngine();
    await engine.start();
    await engine.addExpert(cto);

    // No AbortController — caller never aborts.
    const debate = new Debate(engine, [cto], FREEFORM_1R);
    const events = await collect(debate.run("topic"));

    const errors = events.filter((e) => e.kind === "error");
    // Engine-side abort with no caller-side signal MUST surface as an
    // error so the operator/UI sees what happened.
    expect(errors.length).toBe(1);
    if (errors[0]?.kind === "error") {
      expect(errors[0].message).toBe("engine stopped");
    }
  });

  it("aborting after buildLLMSummary() returns but before the next round.start yields debate.end 'aborted' and issues no further engine.send", async () => {
    // The post-summarizer signal check must catch a Ctrl+C that lands
    // while the summarizer was running. We model this with a
    // SummarizerAbortEngine whose summarizer-call (the second send,
    // identified by expertId === "__summary__") aborts the controller
    // during its stream and then returns normally. The detector for
    // "no further send after summary" is: the engine records exactly
    // one round-0 turn send + one summary send, and no round-1 turn.
    class SummarizerAbortEngine extends RecordingEngine {
      controller: AbortController | undefined;
      override send(options: SendOptions): AsyncIterable<EngineEvent> {
        this.sends.push({ expertId: options.expertId, signal: options.signal });
        const expertId = options.expertId;
        // The summarizer registers a temporary expert with a fresh ULID,
        // so any send for an expertId other than the registered cto is
        // the summarizer call.
        const isSummarizer = expertId !== cto.id;
        const ctl = this.controller;
        return {
          async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
            yield { kind: "message.delta", expertId, text: isSummarizer ? "sum" : "x" };
            if (isSummarizer && ctl) ctl.abort();
            yield {
              kind: "message.complete",
              expertId,
              response: { latencyMs: 1 },
            };
          },
        };
      }
    }

    const engine = new SummarizerAbortEngine();
    engine.controller = new AbortController();
    await engine.start();
    await engine.addExpert(cto);

    const debate = new Debate(engine, [cto], {
      maxRounds: 2,
      maxWordsPerResponse: 50,
      mode: "freeform",
      contextConfig: {
        summarizer: { mode: "llm", summarizeAfterRound: 1, maxSummaryLength: 200 },
      },
    });
    const events = await collect(debate.run("topic", { signal: engine.controller.signal }));

    const ends = events.filter((e) => e.kind === "debate.end");
    expect(ends).toHaveLength(1);
    if (ends[0]?.kind === "debate.end") {
      expect(ends[0].reason).toBe("aborted");
    }
    // Must NOT issue another expert turn after the summary returned.
    const expertSends = engine.sends.filter((s) => s.expertId === cto.id);
    expect(expertSends.length).toBe(1);
  });

  it("aborting during recoverable-retry backoff cancels the retry: no further engine.send is issued", async () => {
    // Engine yields one recoverable error, the orchestrator schedules
    // a backoff sleep, then the caller aborts during the sleep. The
    // retry MUST NOT fire — `engine.send` must be called exactly once.
    class RetryEngine extends RecordingEngine {
      controller: AbortController | undefined;
      override send(options: SendOptions): AsyncIterable<EngineEvent> {
        this.sends.push({ expertId: options.expertId, signal: options.signal });
        const expertId = options.expertId;
        const ctl = this.controller;
        return {
          async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
            yield {
              kind: "error",
              expertId,
              error: { code: "RATE_LIMITED", message: "slow down" },
              recoverable: true,
            };
            // Trigger abort on a microtask so the orchestrator has
            // already entered abortableSleep() before the signal fires.
            if (ctl) {
              setTimeout(() => ctl.abort(), 0);
            }
          },
        };
      }
    }

    const engine = new RetryEngine();
    engine.controller = new AbortController();
    await engine.start();
    await engine.addExpert(cto);

    const debate = new Debate(engine, [cto], FREEFORM_1R);
    await collect(debate.run("topic", { signal: engine.controller.signal }));

    // Exactly one send: the initial attempt. The retry must be skipped
    // because the signal aborted during/after backoff.
    expect(engine.sends.length).toBe(1);
  });
});
