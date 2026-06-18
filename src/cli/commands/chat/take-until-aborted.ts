/**
 * Drive an async stream but stop the instant an {@link AbortSignal} fires.
 *
 * A real Copilot turn arrives from the engine as a single large SDK message,
 * and the adapter only reacts to cancellation at the network layer. A plain
 * `for await (const evt of engine.send(...))` therefore keeps awaiting the
 * in-flight `iterator.next()` until the whole answer has streamed — so a
 * Ctrl+C (SIGINT) delivered mid-stream is observed by the chat loop only
 * AFTER the full response has been drained. The interrupt flag is set, but the
 * partial that gets persisted is actually the complete response.
 *
 * This wrapper closes that gap on the consumer side: it races each pull
 * against the abort signal so the iteration breaks the moment the signal
 * fires, yielding only the tokens received so far. It is intentionally additive
 * and behaviour-preserving when no signal is provided or the signal never
 * aborts — it simply forwards every value through.
 *
 * The upstream request is still cancelled cooperatively at the source: the same
 * signal is forwarded to `engine.send()`, so the adapter can abort the
 * underlying SDK request. On abort this wrapper fire-and-forgets
 * `iterator.return()` to release the source generator. That call is
 * deliberately NOT awaited — a generator parked on an internal `await` (e.g.
 * the adapter awaiting the SDK send promise) would otherwise block the return
 * until the underlying request settles, which is exactly the latency this
 * wrapper exists to avoid. Any rejection from the best-effort cleanup is
 * swallowed so it cannot surface as an unhandled rejection.
 *
 * Mirrors the established racing pattern used by the inline `@convene` debate
 * consumer in `panel-chat.ts`.
 */
export async function* takeUntilAborted<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal | undefined,
): AsyncGenerator<T, void, void> {
  if (signal?.aborted === true) {
    return;
  }

  const iterator = source[Symbol.asyncIterator]();
  const ABORT_SENTINEL = Symbol("take-until-aborted");
  let abortListener: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<typeof ABORT_SENTINEL>((resolve) => {
        abortListener = (): void => resolve(ABORT_SENTINEL);
        signal.addEventListener("abort", abortListener, { once: true });
      })
    : undefined;

  try {
    while (true) {
      const next = abortPromise
        ? await Promise.race([iterator.next(), abortPromise])
        : await iterator.next();

      if (next === ABORT_SENTINEL) {
        // Release the source generator without waiting on its internal awaits
        // (see the doc comment); swallow any cleanup rejection.
        void iterator.return?.(undefined)?.catch(() => undefined);
        return;
      }

      if (next.done === true) {
        return;
      }

      yield next.value;
    }
  } finally {
    if (signal !== undefined && abortListener !== undefined) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}
