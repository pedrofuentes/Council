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
 * - `model`: provider-agnostic model identifier (e.g. "claude-sonnet-4-20250514").
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
 * `expertId` MUST match the `id` of an expert that has already been added
 * via {@link CouncilEngine.addExpert}. Engines reject unknown expert IDs.
 */
export interface SendOptions {
  readonly prompt: string;
  readonly expertId: string;
}

/**
 * Aggregate result of a completed send.
 *
 * - `content`: the full assistant message (concatenation of all stream deltas)
 * - `tokensIn` / `tokensOut`: provider-reported token counts when available
 * - `latencyMs`: wall-clock time from `send()` invocation to final `message.complete`
 */
export interface EngineResponse {
  readonly content: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly latencyMs: number;
}

/**
 * Discriminated union of events the engine streams during a `send()` call.
 *
 * - `message.delta`: incremental token chunk; renderers should append to the
 *   running buffer for the matching `expertId`
 * - `message.complete`: terminal event; the response object aggregates everything
 *   that was streamed and includes telemetry
 * - `error`: recoverable or fatal; downstream orchestration decides how to react
 *   (see `core/debate.ts` retry policy)
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
      readonly error: Error;
      readonly recoverable: boolean;
    };
