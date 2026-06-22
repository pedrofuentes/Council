/**
 * Domain types for the Council engine layer.
 *
 * These types are Council's own domain model — NOT mirrors of the underlying
 * AI provider SDK (e.g. `@github/copilot-sdk`). The `CouncilEngine` interface
 * (see ./index.ts) consumes and produces these types so that `core/`, `cli/`,
 * and `memory/` never reach across the architectural seam to provider types.
 *
 * See DECISIONS.md ADR-003 for the rationale behind the seam.
 */

/**
 * Reasoning effort hint for models that support tunable thinking budgets
 * (e.g., Anthropic's extended thinking, OpenAI o-series effort levels).
 *
 * Engine adapters are free to ignore this if their model does not support it.
 */
export type ReasoningEffort = "low" | "medium" | "high";

/**
 * Specification for a single AI expert participant in a panel.
 *
 * - `id`: stable ULID assigned by Council; used as the routing key in event streams
 * - `slug`: short human-readable identifier scoped to a panel (e.g. "cto", "skeptic")
 * - `displayName`: name shown in transcripts and renderers (e.g. "Dahlia Renner (CTO)")
 * - `model`: provider-agnostic model identifier (e.g. "claude-sonnet-4.5").
 *           Adapters translate to provider-native model names.
 * - `systemMessage`: the full 8-section system prompt produced by `core/prompt-builder`
 * - `reasoningEffort`: optional hint, see {@link ReasoningEffort}
 */
export interface ExpertSpec {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly model: string;
  readonly systemMessage: string;
  readonly reasoningEffort?: ReasoningEffort;
}

/**
 * Arguments for a single send-to-expert call on the engine.
 *
 * - `prompt`: the user/orchestrator turn text — engines pass it through
 *   unmodified. The system prompt is set once via `addExpert(spec.systemMessage)`
 *   and is NOT re-sent per turn.
 * - `expertId`: must match the `id` of an expert already registered via
 *   {@link CouncilEngine.addExpert}. Engines reject unknown IDs.
 * - `signal`: optional `AbortSignal`; when aborted, the engine MUST stop
 *   the in-flight send promptly and yield a terminal `error` event with
 *   `code: "ABORTED"` (see {@link EngineErrorCode}). Adapters MAY also
 *   honor cooperative cancellation when the consumer calls the
 *   AsyncIterator's `return()` method (e.g., breaking out of `for await`).
 */
export interface SendOptions {
  readonly prompt: string;
  readonly expertId: string;
  readonly signal?: AbortSignal;
}

/**
 * Aggregate result of a completed send.
 *
 * - `tokensIn` / `tokensOut`: provider-reported token counts when available
 * - `latencyMs`: wall-clock time from `send()` invocation to the terminal event
 *
 * Note: full content is NOT included here. Consumers that need the assembled
 * response should accumulate `message.delta.text` themselves. This keeps
 * adapters from needing to maintain a parallel buffer and lets transcript
 * assembly live in `core/debate.ts` (the single source of truth for what
 * gets persisted).
 */
export interface EngineResponse {
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly latencyMs: number;
}

/**
 * Stable, provider-agnostic error codes surfaced by every engine adapter.
 *
 * Adapters MUST translate provider-native errors into one of these codes
 * before yielding an `error` event. New codes require an ADR.
 *
 * - `ABORTED`: caller's `AbortSignal` fired or iterator was returned early
 * - `NOT_AUTHENTICATED`: provider credentials are missing or invalid
 * - `RATE_LIMITED`: provider quota exhausted; consult `retryAfterMs`
 * - `MODEL_UNAVAILABLE`: requested model is not reachable via this engine
 * - `CONTEXT_OVERFLOW`: prompt + history exceed the model's context window
 * - `NETWORK`: transient network failure; usually `recoverable: true`
 * - `PROVIDER_ERROR`: provider returned an error not mapped to anything more
 *   specific; adapters SHOULD attach a `cause` for diagnostics
 * - `INTERNAL`: bug in the engine adapter itself (assertion failure, etc.)
 */
export type EngineErrorCode =
  | "ABORTED"
  | "NOT_AUTHENTICATED"
  | "RATE_LIMITED"
  | "MODEL_UNAVAILABLE"
  | "CONTEXT_OVERFLOW"
  | "NETWORK"
  | "PROVIDER_ERROR"
  | "INTERNAL";

/**
 * Structured, serializable error surfaced via the `error` event.
 *
 * Unlike a raw `Error`, this is a plain readonly object that:
 *   - Has a stable `code` field for log-based classification and metric tags
 *   - Is JSON-serializable end-to-end (renderer → persistence → export)
 *   - Hides provider-native error subclasses behind the seam
 *
 * `cause` carries the original error object for diagnostics (`unknown` so we
 * never trust its shape; access via instance checks at the boundary).
 */
export interface EngineError {
  readonly code: EngineErrorCode;
  readonly message: string;
  readonly cause?: unknown;
  /** Set by `RATE_LIMITED` (and sometimes `NETWORK`) when known. */
  readonly retryAfterMs?: number;
  /** Optional provider tag for diagnostics, e.g. `"copilot"` / `"anthropic"`. */
  readonly provider?: string;
}

/**
 * Discriminated union of events the engine streams during a `send()` call.
 *
 * - `message.delta`: incremental token chunk; renderers should append to the
 *   running buffer for the matching `expertId`
 * - `message.complete`: terminal success event with token/latency telemetry
 *   (no content — accumulate from deltas; see {@link EngineResponse})
 * - `error`: terminal failure event; `recoverable` is derived from
 *   `error.code` (e.g., `ABORTED` is not recoverable, `RATE_LIMITED` is)
 *
 * Exactly one terminal event (`message.complete` or `error`) is yielded per
 * `send()` call. After the terminal event, the iterator is done.
 */
export type EngineEvent =
  | {
      readonly kind: "message.delta";
      readonly expertId: string;
      readonly text: string;
    }
  | {
      readonly kind: "message.complete";
      readonly expertId: string;
      readonly response: EngineResponse;
    }
  | {
      readonly kind: "error";
      readonly expertId: string;
      readonly error: EngineError;
      readonly recoverable: boolean;
    };
