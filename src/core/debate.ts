/**
 * Debate orchestrator — sequential turn-based panel chat.
 *
 * Two modes (`DebateConfig.mode`):
 *
 *   - `"freeform"` (ROADMAP §1.8): N rounds of round-robin chat. Each
 *     round, every expert speaks once on the same prompt. Stops at
 *     `maxRounds`. This is the default for `convene` debates.
 *
 *   - `"structured"` (ROADMAP §2.2): fixed 4-phase choreography —
 *     opening → cross-examination → rebuttal → synthesis — regardless
 *     of `maxRounds`. Each phase emits one round.start/round.end pair
 *     with a `phase` field. The cross-examination phase is skipped when
 *     there is only one expert in the panel (3 phases total).
 *
 * The orchestrator translates engine events (`message.delta`,
 * `message.complete`, `error`) into Council domain events
 * (`turn.delta`, `turn.end`, `error`) and emits structural events
 * (`panel.assembled`, `round.start`, `round.end`, `cost.update`,
 * `debate.end`).
 *
 * Persistence is OUT OF SCOPE — consumers wire the stream to
 * `TurnRepository.create()` themselves on `turn.end` events. The
 * orchestrator generates `turnId`s but does not write to the database.
 */
import { ulid } from "ulid";

import type { CouncilEngine, ExpertSpec } from "../engine/index.js";

import {
  buildCrossExamPrompt,
  buildOpeningPrompt,
  buildRebuttalPrompt,
  buildSynthesisPrompt,
  type PriorTurn,
} from "./moderator/phase-prompts.js";
import type { DebateEvent, DebatePhase } from "./types.js";

export type DebateMode = "freeform" | "structured";

export interface DebateConfig {
  readonly maxRounds: number;
  readonly maxWordsPerResponse: number;
  readonly mode: DebateMode;
  readonly moderatorModel?: string;
  /**
   * Backoff delays in ms between retry attempts on recoverable engine
   * errors (#3.7). Length determines the maximum number of retries
   * (e.g. `[250, 1000]` = up to 2 retries). Default: `[250, 1000]`
   * (250ms then 1s exponential). Tests pass `[1, 2]` to keep the
   * suite fast.
   *
   * Only RATE_LIMITED and NETWORK errors trigger a retry; all other
   * EngineErrorCode values fail fast.
   */
  readonly retryBackoffMs?: readonly number[];
}

/** Default retry backoff per ROADMAP §3.7 — 250ms, then 1s. */
const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [250, 1000];

interface RunCounters {
  premiumRequests: number;
  estimatedTotal: number;
}

export class Debate {
  constructor(
    private readonly engine: CouncilEngine,
    private readonly experts: readonly ExpertSpec[],
    private readonly config: DebateConfig,
  ) {}

  async *run(prompt: string): AsyncIterable<DebateEvent> {
    yield {
      kind: "panel.assembled",
      experts: this.experts.map((e) => ({
        slug: e.slug,
        displayName: e.displayName,
        model: e.model,
      })),
    };

    if (this.config.mode === "structured") {
      yield* this.#runStructured(prompt);
    } else {
      yield* this.#runFreeform(prompt);
    }
  }

  // -------------- Freeform mode (unchanged from §1.8) --------------

  async *#runFreeform(prompt: string): AsyncGenerator<DebateEvent> {
    const counters: RunCounters = {
      premiumRequests: 0,
      estimatedTotal: this.experts.length * this.config.maxRounds,
    };

    for (let round = 0; round < this.config.maxRounds; round++) {
      yield { kind: "round.start", round };
      let seq = 0;
      for (const expert of this.experts) {
        yield* this.#runTurn(expert, prompt, round, seq, counters);
        seq += 1;
      }
      yield { kind: "round.end", round };
    }

    yield { kind: "debate.end", reason: "completed" };
  }

  // -------------- Structured mode (§2.2) --------------

  async *#runStructured(topic: string): AsyncGenerator<DebateEvent> {
    // Phases that fire. Cross-exam is skipped for single-expert panels
    // since there is no one to cross-examine.
    const phases: readonly DebatePhase[] =
      this.experts.length === 1
        ? ["opening", "rebuttal", "synthesis"]
        : ["opening", "cross-examination", "rebuttal", "synthesis"];

    const counters: RunCounters = {
      premiumRequests: 0,
      estimatedTotal: this.experts.length * phases.length,
    };

    const openingTurns: PriorTurn[] = [];
    const crossExamTurns: PriorTurn[] = [];
    const rebuttalTurns: PriorTurn[] = [];

    for (const [phaseIdx, phase] of phases.entries()) {
      yield { kind: "round.start", round: phaseIdx, phase };

      let seq = 0;
      for (const expert of this.experts) {
        const phasePrompt = this.#buildPhasePrompt(
          phase,
          topic,
          expert,
          openingTurns,
          crossExamTurns,
          rebuttalTurns,
        );

        // Single-expert cross-exam returns null — but we already filter
        // that phase out above, so this is only a defensive guard.
        if (phasePrompt === null) {
          seq += 1;
          continue;
        }

        const captured = yield* this.#runTurn(expert, phasePrompt, phaseIdx, seq, counters);

        if (captured !== null) {
          const turn: PriorTurn = {
            expertSlug: expert.slug,
            displayName: expert.displayName,
            content: captured,
          };
          if (phase === "opening") openingTurns.push(turn);
          else if (phase === "cross-examination") crossExamTurns.push(turn);
          else if (phase === "rebuttal") rebuttalTurns.push(turn);
          // synthesis turns aren't fed back into any later prompt.
        }
        seq += 1;
      }

      yield { kind: "round.end", round: phaseIdx, phase };
    }

    yield { kind: "debate.end", reason: "completed" };
  }

  #buildPhasePrompt(
    phase: DebatePhase,
    topic: string,
    expert: ExpertSpec,
    openingTurns: readonly PriorTurn[],
    crossExamTurns: readonly PriorTurn[],
    rebuttalTurns: readonly PriorTurn[],
  ): string | null {
    switch (phase) {
      case "opening":
        return buildOpeningPrompt(topic);
      case "cross-examination":
        return buildCrossExamPrompt(topic, expert, openingTurns);
      case "rebuttal":
        return buildRebuttalPrompt(topic, expert, openingTurns, crossExamTurns);
      case "synthesis":
        return buildSynthesisPrompt(topic, expert, openingTurns, crossExamTurns, rebuttalTurns);
    }
  }

  /**
  /**
   * Runs one expert's turn end-to-end. Yields all related debate events
   * and returns the accumulated response content (or `null` if the turn
   * failed / errored). Updates `counters.premiumRequests` and emits a
   * `cost.update` after every turn.
   *
   * **Retry semantics (#3.7)**: when an attempt yields an `error` event
   * with `recoverable: true`, the orchestrator emits a `turn.retry`
   * event, sleeps for the matching backoff delay, and retries the send.
   * Retries cap at `config.retryBackoffMs.length` attempts (default 2).
   * Non-recoverable errors fail fast (no retry). Synchronous throws
   * from `engine.send()` (e.g. unregistered expert) are not retried.
   *
   * Each attempt accumulates its own delta content; partial content
   * from a failed attempt is discarded so retried turns start fresh.
   */
  async *#runTurn(
    expert: ExpertSpec,
    prompt: string,
    round: number,
    seq: number,
    counters: RunCounters,
  ): AsyncGenerator<DebateEvent, string | null> {
    yield { kind: "turn.start", expertSlug: expert.slug, round, seq };

    const backoffMs = this.config.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    const maxRetries = backoffMs.length;

    let content = "";
    let turnFailed = false;
    let lastErrorRecoverable = false;
    let lastErrorMessage = "";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Reset per-attempt state — partial deltas from a failed attempt
      // must not bleed into the retry's content.
      content = "";
      let attemptFailed = false;
      lastErrorRecoverable = false;
      lastErrorMessage = "";

      try {
        for await (const evt of this.engine.send({ prompt, expertId: expert.id })) {
          switch (evt.kind) {
            case "message.delta": {
              content += evt.text;
              yield { kind: "turn.delta", expertSlug: expert.slug, text: evt.text };
              break;
            }
            case "message.complete": {
              // turn.end is yielded after the loop with accumulated content.
              break;
            }
            case "error": {
              attemptFailed = true;
              lastErrorRecoverable = evt.recoverable;
              lastErrorMessage = evt.error.message;
              break;
            }
          }
        }
      } catch (err: unknown) {
        // Synchronous validation failures (e.g. unregistered expert)
        // bubble out as thrown Errors. Treat as non-recoverable —
        // retrying the same registration error would just re-throw.
        attemptFailed = true;
        lastErrorRecoverable = false;
        lastErrorMessage = err instanceof Error ? err.message : String(err);
      }

      if (!attemptFailed) {
        // Success — break the retry loop with content set.
        turnFailed = false;
        break;
      }

      // Decide whether to retry.
      if (lastErrorRecoverable && attempt < maxRetries) {
        const delay = backoffMs[attempt] ?? 0;
        yield {
          kind: "turn.retry",
          expertSlug: expert.slug,
          attempt: attempt + 1,
          reason: lastErrorMessage,
        };
        if (delay > 0) await sleep(delay);
        continue; // try again
      }

      // Either non-recoverable, or retries exhausted: emit final error.
      turnFailed = true;
      yield {
        kind: "error",
        expertSlug: expert.slug,
        message: lastErrorMessage,
        recoverable: lastErrorRecoverable,
      };
      break;
    }

    if (!turnFailed) {
      const turnId = ulid();
      yield { kind: "turn.end", expertSlug: expert.slug, turnId, content };
    }

    counters.premiumRequests += 1;
    yield {
      kind: "cost.update",
      premiumRequests: counters.premiumRequests,
      estimatedTotal: counters.estimatedTotal,
    };

    return turnFailed ? null : content;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Re-export for callers consuming both the orchestrator and event types. */
export type { DebateEvent } from "./types.js";
