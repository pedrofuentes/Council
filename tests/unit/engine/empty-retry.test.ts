/**
 * Unit tests for the shared empty-response retry helper
 * (`src/engine/empty-retry.ts`), used by BOTH the panel-chat path and the
 * debate/convene path (T14).
 *
 * Contract:
 *   - A non-failed response whose text is empty or whitespace-only is
 *     retried exactly ONCE with the same send options.
 *   - If the retry produces content, that content wins (`emptyAfterRetry`
 *     is false). If it's empty again, `emptyAfterRetry` is true so callers
 *     can surface a clear reason and continue.
 *   - A failed (error) response is NOT retried for emptiness — the error
 *     is reported so the caller's own error-retry policy applies.
 *   - An aborted send is NOT retried for emptiness.
 *
 * RED at this commit: `src/engine/empty-retry.ts` does not exist yet.
 */
import { describe, expect, it } from "vitest";

import {
  collectSendWithEmptyRetry,
  isEmptyResponse,
  sendWithEmptyRetry,
  type EmptyRetryOutcome,
  type SendRetryEvent,
} from "../../../src/engine/empty-retry.js";
import type { SendOptions } from "../../../src/engine/index.js";
import { ScriptedEngine, type ScriptStep } from "../../helpers/scripted-engine.js";

const EXPERT_ID = "expert-1";
const OPTS: SendOptions = { prompt: "hello", expertId: EXPERT_ID };

function engineOf(...steps: readonly ScriptStep[]): ScriptedEngine {
  return new ScriptedEngine({ scripts: { [EXPERT_ID]: steps } });
}

async function drain(
  gen: AsyncGenerator<SendRetryEvent, EmptyRetryOutcome>,
): Promise<{ readonly events: SendRetryEvent[]; readonly outcome: EmptyRetryOutcome }> {
  const events: SendRetryEvent[] = [];
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, outcome: step.value };
}

describe("isEmptyResponse", () => {
  it("is true for empty and whitespace-only strings", () => {
    expect(isEmptyResponse("")).toBe(true);
    expect(isEmptyResponse("   ")).toBe(true);
    expect(isEmptyResponse("\n\t  \r\n")).toBe(true);
  });

  it("is false for strings with any non-whitespace content", () => {
    expect(isEmptyResponse("x")).toBe(false);
    expect(isEmptyResponse("  hi  ")).toBe(false);
  });
});

describe("sendWithEmptyRetry", () => {
  it("retries once and yields the content when the first response is empty then non-empty", async () => {
    const engine = engineOf({ kind: "content", text: "" }, { kind: "content", text: "real answer" });

    const { events, outcome } = await drain(sendWithEmptyRetry(engine, OPTS));

    expect(outcome.content).toBe("real answer");
    expect(outcome.failed).toBe(false);
    expect(outcome.retriedForEmpty).toBe(true);
    expect(outcome.emptyAfterRetry).toBe(false);
    // The empty response must NOT be silently dropped — a retry actually fired.
    expect(engine.sendCount(EXPERT_ID)).toBe(2);
    expect(events).toContainEqual({ kind: "empty-retry" });
  });

  it("surfaces a reason (does not crash) when the response is empty twice", async () => {
    const engine = engineOf({ kind: "content", text: "" }, { kind: "content", text: "   " });

    const { outcome } = await drain(sendWithEmptyRetry(engine, OPTS));

    expect(outcome.failed).toBe(false);
    expect(outcome.retriedForEmpty).toBe(true);
    expect(outcome.emptyAfterRetry).toBe(true);
    expect(isEmptyResponse(outcome.content)).toBe(true);
    expect(engine.sendCount(EXPERT_ID)).toBe(2);
  });

  it("does not retry when the first response already has content", async () => {
    const engine = engineOf({ kind: "content", text: "first try is fine" });

    const { events, outcome } = await drain(sendWithEmptyRetry(engine, OPTS));

    expect(outcome.content).toBe("first try is fine");
    expect(outcome.retriedForEmpty).toBe(false);
    expect(outcome.emptyAfterRetry).toBe(false);
    expect(engine.sendCount(EXPERT_ID)).toBe(1);
    expect(events).not.toContainEqual({ kind: "empty-retry" });
  });

  it("treats a whitespace-only first response as empty and retries", async () => {
    const engine = engineOf({ kind: "content", text: "  \n " }, { kind: "content", text: "now content" });

    const { outcome } = await drain(sendWithEmptyRetry(engine, OPTS));

    expect(outcome.content).toBe("now content");
    expect(outcome.retriedForEmpty).toBe(true);
    expect(engine.sendCount(EXPERT_ID)).toBe(2);
  });

  it("does NOT retry a failed (error) response — reports the error instead", async () => {
    const engine = engineOf({
      kind: "error",
      code: "RATE_LIMITED",
      message: "throttled",
      recoverable: true,
    });

    const { outcome } = await drain(sendWithEmptyRetry(engine, OPTS));

    expect(outcome.failed).toBe(true);
    expect(outcome.recoverable).toBe(true);
    expect(outcome.errorCode).toBe("RATE_LIMITED");
    expect(outcome.errorMessage).toBe("throttled");
    expect(outcome.retriedForEmpty).toBe(false);
    expect(outcome.emptyAfterRetry).toBe(false);
    expect(engine.sendCount(EXPERT_ID)).toBe(1);
  });

  it("does NOT retry for emptiness when the caller's signal is already aborted", async () => {
    const engine = engineOf({ kind: "content", text: "" });
    const controller = new AbortController();
    controller.abort();

    const { outcome } = await drain(
      sendWithEmptyRetry(engine, { ...OPTS, signal: controller.signal }),
    );

    expect(outcome.retriedForEmpty).toBe(false);
    expect(outcome.emptyAfterRetry).toBe(false);
    expect(engine.sendCount(EXPERT_ID)).toBe(1);
  });
});

describe("collectSendWithEmptyRetry", () => {
  it("returns the same outcome as draining the generator (retry path)", async () => {
    const engine = engineOf({ kind: "content", text: "" }, { kind: "content", text: "collected" });

    const outcome = await collectSendWithEmptyRetry(engine, OPTS);

    expect(outcome.content).toBe("collected");
    expect(outcome.retriedForEmpty).toBe(true);
    expect(outcome.emptyAfterRetry).toBe(false);
    expect(engine.sendCount(EXPERT_ID)).toBe(2);
  });

  it("reports emptyAfterRetry when both attempts are empty", async () => {
    const engine = engineOf({ kind: "content", text: "" }, { kind: "content", text: "" });

    const outcome = await collectSendWithEmptyRetry(engine, OPTS);

    expect(outcome.emptyAfterRetry).toBe(true);
    expect(engine.sendCount(EXPERT_ID)).toBe(2);
  });
});
