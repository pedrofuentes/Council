/**
 * MockEngine — deterministic, in-memory CouncilEngine for tests and
 * offline development.
 *
 * Design goals:
 *   1. Deterministic event sequence. Same inputs always produce the same
 *      sequence of events; latency reflects wall-clock and is NOT pinned
 *      (tests should not assert exact `latencyMs` values, only ranges).
 *   2. Contract-faithful. MockEngine is the reference implementation of
 *      every clause of the CouncilEngine contract — lifecycle idempotency,
 *      cancellation, error semantics — so that tests written against it
 *      will continue to pass when run against CopilotEngine (Phase 1.4).
 *   3. Configurable. Tests can pre-seed responses, configure failures,
 *      and tune delta timing without touching the production code path.
 *
 * NOT goals: realistic latency, faithful tokenization, semantic responses.
 */
import type {
  CouncilEngine,
  EngineError,
  EngineErrorCode,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../index.js";

/**
 * Recoverability mapping for {@link EngineErrorCode}.
 *
 * Closes issue #9 — every adapter must derive `EngineEvent.error.recoverable`
 * from this single source of truth so retry decisions in `core/debate.ts`
 * are consistent across providers.
 */
export function isRecoverable(code: EngineErrorCode): boolean {
  switch (code) {
    case "RATE_LIMITED":
    case "NETWORK":
      return true;
    case "ABORTED":
    case "NOT_AUTHENTICATED":
    case "MODEL_UNAVAILABLE":
    case "CONTEXT_OVERFLOW":
    case "PROVIDER_ERROR":
    case "INTERNAL":
      return false;
  }
}

export interface MockEngineOptions {
  /** Map of expertId → response text. Default: a generic stub per expert. */
  readonly responses?: Readonly<Record<string, string>>;
  /** Map of expertId → seeded failure. Set to make `send()` yield an error event. */
  readonly failures?: Readonly<Record<string, Pick<EngineError, "code" | "message">>>;
  /**
   * Delay between delta chunks in ms. Default 0 (synchronous-ish, fast tests).
   * Tests that exercise cancellation-mid-stream should set this >0.
   */
  readonly deltaDelayMs?: number;
  /** Override the model identifier returned by listModels(). */
  readonly modelName?: string;
}

const SENTENCE_SPLIT = /([.!?]\s+)/;

function defaultResponse(expertId: string): string {
  return `[mock response from ${expertId}]`;
}

function chunkResponse(text: string): string[] {
  // Split on sentence boundaries so deltas feel natural; fallback to whole
  // string if the response has no terminators.
  const parts = text.split(SENTENCE_SPLIT).filter((p) => p.length > 0);
  if (parts.length <= 1) return [text];
  // Reassemble pairs (sentence + terminator) into single chunks.
  const chunks: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i] ?? "";
    const term = parts[i + 1] ?? "";
    chunks.push(sentence + term);
  }
  return chunks;
}

function approximateTokens(text: string): number {
  // Rough 4-chars-per-token approximation; deterministic for tests.
  return Math.max(1, Math.ceil(text.length / 4));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface InFlight {
  readonly controller: AbortController;
  readonly expertId: string;
}

export class MockEngine implements CouncilEngine {
  readonly #options: Required<MockEngineOptions>;
  readonly #experts = new Map<string, ExpertSpec>();
  readonly #inFlight = new Set<InFlight>();
  readonly #sentPrompts: { readonly expertId: string; readonly prompt: string }[] = [];
  #stopped = false;

  /**
   * Test-only accessor: every prompt sent via `send()`, in temporal order.
   * Captured at the synchronous validation boundary so it reflects the
   * caller's intent regardless of stream consumption / cancellation.
   */
  get sentPrompts(): readonly { readonly expertId: string; readonly prompt: string }[] {
    return this.#sentPrompts;
  }

  constructor(options: MockEngineOptions = {}) {
    this.#options = {
      responses: options.responses ?? {},
      failures: options.failures ?? {},
      deltaDelayMs: options.deltaDelayMs ?? 0,
      modelName: options.modelName ?? "mock-model",
    };
  }

  async start(): Promise<void> {
    // Idempotent: re-starting after stop is allowed (test fixtures may reset).
    this.#stopped = false;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return; // idempotent
    this.#stopped = true;
    // Abort every in-flight send; their iterators will yield ABORTED + done.
    for (const f of this.#inFlight) {
      f.controller.abort();
    }
    this.#inFlight.clear();
  }

  async addExpert(spec: ExpertSpec): Promise<void> {
    if (this.#experts.has(spec.id)) {
      throw new Error(`Expert ${spec.id} is already registered`);
    }
    this.#experts.set(spec.id, spec);
  }

  async removeExpert(expertId: string): Promise<void> {
    this.#experts.delete(expertId);
    // Abort any in-flight sends for this expert.
    for (const f of this.#inFlight) {
      if (f.expertId === expertId) {
        f.controller.abort();
      }
    }
  }

  async listModels(): Promise<readonly string[]> {
    return [this.#options.modelName];
  }

  send(options: SendOptions): AsyncIterable<EngineEvent> {
    // Synchronous validation per CouncilEngine contract.
    if (!this.#experts.has(options.expertId)) {
      throw new Error(`Expert ${options.expertId} is not registered`);
    }
    // Capture for test verification (see `sentPrompts` getter). Captured
    // before any async work so the order matches the caller's intent.
    this.#sentPrompts.push({ expertId: options.expertId, prompt: options.prompt });

    // Bind the in-flight tracker BEFORE returning the iterable so that
    // stop()/removeExpert() called between this line and the consumer's
    // first next() still aborts cleanly.
    const controller = new AbortController();
    const inFlight: InFlight = { controller, expertId: options.expertId };
    this.#inFlight.add(inFlight);

    // Wire the caller's signal so AbortController sees both sources.
    // Capture the listener so we can remove it in the stream's `finally`,
    // preventing memory growth when callers reuse the same AbortSignal
    // across many sends. (Sentinel pr16 finding #1.)
    let removeCallerSignalListener: (() => void) | undefined;
    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        const onAbort = (): void => controller.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeCallerSignalListener = (): void => {
          options.signal?.removeEventListener("abort", onAbort);
        };
      }
    }

    const failure = this.#options.failures[options.expertId];
    const text = this.#options.responses[options.expertId] ?? defaultResponse(options.expertId);
    const deltaDelayMs = this.#options.deltaDelayMs;

    return this.#stream(inFlight, options.expertId, text, deltaDelayMs, failure, removeCallerSignalListener);
  }

  async *#stream(
    inFlight: InFlight,
    expertId: string,
    text: string,
    deltaDelayMs: number,
    failure: Pick<EngineError, "code" | "message"> | undefined,
    removeCallerSignalListener: (() => void) | undefined,
  ): AsyncGenerator<EngineEvent, void, void> {
    const start = Date.now();
    try {
      // Configured failure short-circuits before any delta.
      if (failure) {
        yield {
          kind: "error",
          expertId,
          error: { ...failure, provider: "mock" },
          recoverable: isRecoverable(failure.code),
        };
        return;
      }

      // Cancellation check before any work (handles pre-aborted signals).
      if (inFlight.controller.signal.aborted) {
        yield {
          kind: "error",
          expertId,
          error: { code: "ABORTED", message: "Send was aborted before any delta", provider: "mock" },
          recoverable: isRecoverable("ABORTED"),
        };
        return;
      }

      const chunks = chunkResponse(text);
      for (const chunk of chunks) {
        try {
          await delay(deltaDelayMs, inFlight.controller.signal);
        } catch {
          yield {
            kind: "error",
            expertId,
            error: { code: "ABORTED", message: "Send was aborted mid-stream", provider: "mock" },
            recoverable: isRecoverable("ABORTED"),
          };
          return;
        }
        if (inFlight.controller.signal.aborted) {
          yield {
            kind: "error",
            expertId,
            error: { code: "ABORTED", message: "Send was aborted mid-stream", provider: "mock" },
            recoverable: isRecoverable("ABORTED"),
          };
          return;
        }
        yield { kind: "message.delta", expertId, text: chunk };
      }

      yield {
        kind: "message.complete",
        expertId,
        response: {
          latencyMs: Date.now() - start,
          tokensIn: approximateTokens(text),
          tokensOut: approximateTokens(text),
        },
      };
    } finally {
      this.#inFlight.delete(inFlight);
      removeCallerSignalListener?.();
    }
  }
}
