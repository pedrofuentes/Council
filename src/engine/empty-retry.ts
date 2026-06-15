/**
 * Shared "empty response" retry guard (T14).
 *
 * Experts intermittently complete a turn with no text — a clean
 * `message.complete` with zero (or whitespace-only) deltas. Left
 * unhandled this surfaces to the user as a degraded result with no
 * recourse. This helper gives BOTH the panel-chat path and the
 * debate/convene path one place to:
 *
 *   1. detect an empty/whitespace-only (non-failed) response,
 *   2. retry the SAME send exactly once, and
 *   3. report whether the response was still empty after the retry so the
 *      caller can surface a clear reason and continue gracefully.
 *
 * A *failed* response (terminal `error` event) is NOT retried here — the
 * caller's own error-retry policy owns that case. An already-aborted send
 * is likewise never reissued.
 *
 * The generator form ({@link sendWithEmptyRetry}) lets streaming callers
 * (debate) forward deltas live and react to the retry boundary; the
 * collected form ({@link collectSendWithEmptyRetry}) suits callers that
 * accumulate the full response before rendering (panel-chat).
 */
import type { EngineErrorCode, EngineEvent, SendOptions } from "./types.js";

/**
 * Minimal engine surface this guard needs. Any {@link CouncilEngine} is
 * assignable; keeping it structural avoids a circular import with
 * `./index.ts` (which re-exports this module).
 */
export interface SendCapableEngine {
  send(options: SendOptions): AsyncIterable<EngineEvent>;
}

/** A response is "empty" when it contains no non-whitespace characters. */
export function isEmptyResponse(content: string): boolean {
  return content.trim().length === 0;
}

/**
 * Events surfaced by {@link sendWithEmptyRetry} so streaming callers can
 * react live:
 *   - `delta`: a chunk of assistant text (forward to a renderer / accumulate)
 *   - `empty-retry`: the first attempt completed empty; the retry is firing now
 */
export type SendRetryEvent =
  | { readonly kind: "delta"; readonly text: string }
  | { readonly kind: "empty-retry" };

/** Result of consuming a single `engine.send()` stream. */
interface ConsumeOutcome {
  /** Accumulated assistant text from all `message.delta` events. */
  readonly content: string;
  /** True when the stream ended in a terminal `error` event (or a throw). */
  readonly failed: boolean;
  /** `error.recoverable` for a failed send; false otherwise. */
  readonly recoverable: boolean;
  /** `error.message` for a failed send; empty string otherwise. */
  readonly errorMessage: string;
  /** `error.code` for a failed send; null otherwise. */
  readonly errorCode: EngineErrorCode | null;
}

/** Result of {@link sendWithEmptyRetry} / {@link collectSendWithEmptyRetry}. */
export interface EmptyRetryOutcome extends ConsumeOutcome {
  /** True when an empty first attempt triggered a second send. */
  readonly retriedForEmpty: boolean;
  /** True when the response was still empty AFTER a (non-failed) retry. */
  readonly emptyAfterRetry: boolean;
}

/**
 * Consume exactly one `engine.send()` stream, yielding text deltas and
 * returning the aggregate outcome. A synchronous throw from `engine.send`
 * (e.g. an unregistered expert) propagates to the consumer of this
 * generator, preserving each caller's existing try/catch handling.
 */
async function* consumeOneSend(
  engine: SendCapableEngine,
  options: SendOptions,
): AsyncGenerator<SendRetryEvent, ConsumeOutcome> {
  let content = "";
  let failed = false;
  let recoverable = false;
  let errorMessage = "";
  let errorCode: EngineErrorCode | null = null;

  for await (const evt of engine.send(options)) {
    switch (evt.kind) {
      case "message.delta": {
        content += evt.text;
        yield { kind: "delta", text: evt.text };
        break;
      }
      case "message.complete": {
        break;
      }
      case "error": {
        failed = true;
        recoverable = evt.recoverable;
        errorMessage = evt.error.message;
        errorCode = evt.error.code;
        break;
      }
    }
  }

  return { content, failed, recoverable, errorMessage, errorCode };
}

/**
 * Send to an expert, retrying ONCE if the first response completes empty.
 *
 * Yields {@link SendRetryEvent}s (deltas and a single `empty-retry`
 * boundary marker) and returns an {@link EmptyRetryOutcome}. The retry is
 * skipped when the first response failed, already had content, or the
 * caller's signal is aborted.
 */
export async function* sendWithEmptyRetry(
  engine: SendCapableEngine,
  options: SendOptions,
): AsyncGenerator<SendRetryEvent, EmptyRetryOutcome> {
  const first = yield* consumeOneSend(engine, options);

  if (first.failed || !isEmptyResponse(first.content) || options.signal?.aborted === true) {
    return { ...first, retriedForEmpty: false, emptyAfterRetry: false };
  }

  yield { kind: "empty-retry" };
  const second = yield* consumeOneSend(engine, options);
  return {
    ...second,
    retriedForEmpty: true,
    emptyAfterRetry: !second.failed && isEmptyResponse(second.content),
  };
}

/**
 * Drain {@link sendWithEmptyRetry} and return only its final outcome — for
 * callers (panel-chat) that accumulate the full response before rendering
 * rather than streaming deltas live.
 */
export async function collectSendWithEmptyRetry(
  engine: SendCapableEngine,
  options: SendOptions,
): Promise<EmptyRetryOutcome> {
  const gen = sendWithEmptyRetry(engine, options);
  let step = await gen.next();
  while (!step.done) {
    step = await gen.next();
  }
  return step.value;
}
