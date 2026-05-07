/**
 * Public entry for the Council engine layer.
 *
 * `CouncilEngine` is THE architectural seam between Council's domain logic
 * (in `src/core/`, `src/cli/`, `src/memory/`) and the underlying AI provider
 * (currently `@github/copilot-sdk`, future: Anthropic / OpenAI direct).
 *
 * Rules (enforced by ESLint `no-restricted-imports` + AGENTS.md):
 *   - `src/engine/copilot/adapter.ts` is the ONLY file allowed to import the
 *     Copilot SDK.
 *   - All other code MUST import from this file (or `./types`), never from
 *     the provider package.
 *
 * See DECISIONS.md ADR-003 for the rationale.
 */
export type {
  EngineEvent,
  EngineResponse,
  ExpertSpec,
  ReasoningEffort,
  SendOptions,
} from "./types.js";

import type { EngineEvent, ExpertSpec, SendOptions } from "./types.js";

/**
 * Provider-agnostic AI engine consumed by the debate orchestrator.
 *
 * Lifecycle:
 *   1. `start()` — boot the underlying provider (e.g. spawn the Copilot CLI)
 *   2. `addExpert(spec)` per expert in the panel — creates an isolated session
 *      and primes it with the expert's system prompt
 *   3. `send(options)` per turn — yields a stream of {@link EngineEvent}
 *   4. `removeExpert(id)` when an expert is dropped from the panel
 *   5. `stop()` — release all sessions and tear down the provider connection
 *
 * Implementations:
 *   - {@link MockEngine} (Phase 1.3) — deterministic, in-memory; used by all
 *     unit tests and for offline development
 *   - {@link CopilotEngine} (Phase 1.4) — wraps `@github/copilot-sdk`
 *
 * Implementations MUST be safe to call `stop()` multiple times and MUST treat
 * `removeExpert` of an unknown id as a no-op (idempotent teardown).
 */
export interface CouncilEngine {
  /** Boot the underlying provider. Must complete before any other method. */
  start(): Promise<void>;

  /** Tear down the provider and release all expert sessions. Idempotent. */
  stop(): Promise<void>;

  /**
   * Register an expert and prime its session with the provided system message.
   * Throws if `spec.id` is already registered (call `removeExpert` first).
   */
  addExpert(spec: ExpertSpec): Promise<void>;

  /**
   * Drop an expert and release its session. No-op for unknown IDs.
   */
  removeExpert(expertId: string): Promise<void>;

  /**
   * Send a prompt to a registered expert and stream the response.
   *
   * Yields a sequence of events ending in either `message.complete` (success)
   * or `error` (failure). For partial failures with `recoverable: true`, the
   * caller (typically the debate orchestrator) decides whether to retry.
   *
   * Throws synchronously (before any event is yielded) if `options.expertId`
   * was never registered via `addExpert`.
   */
  send(options: SendOptions): AsyncIterable<EngineEvent>;

  /**
   * List the model identifiers the engine can route to.
   *
   * Used by `council doctor` and the auto-composer to validate that an
   * expert's `model` field is reachable.
   */
  listModels(): Promise<readonly string[]>;
}
