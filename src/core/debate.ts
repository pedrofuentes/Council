/**
 * Debate orchestrator — sequential turn-based panel chat.
 *
 * Two modes (`DebateConfig.mode`):
 *
 *   - `"freeform"` (ROADMAP §1.8 + §2.3): N rounds of moderated chat.
 *     Each round, the configured `ModeratorStrategy` (default
 *     `round-robin`) decides which experts speak and with what prompt.
 *     `consensus-check` and similar strategies may terminate the
 *     debate early via `shouldContinue()` → `debate.end { reason:
 *     "consensus" }`. Stops at `maxRounds` otherwise.
 *
 *   - `"structured"` (ROADMAP §2.2): fixed 4-phase choreography —
 *     opening → cross-examination → rebuttal → synthesis — regardless
 *     of `maxRounds`. Each phase emits one round.start/round.end pair
 *     with a `phase` field. The cross-examination phase is skipped when
 *     there is only one expert in the panel (3 phases total).
 *     `DebateConfig.strategy` is ignored in structured mode.
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
import type { HumanInputProvider } from "./human-input.js";

import { buildHeuristicSummary, buildLLMSummary, type SummarizerConfig } from "./context/summarizer.js";
import { filterPriorTurns, type VisibilityConfig } from "./context/visibility.js";
import {
  buildCrossExamPrompt,
  buildOpeningPrompt,
  buildRebuttalPrompt,
  buildSynthesisPrompt,
  type PriorTurn,
} from "./moderator/phase-prompts.js";
import { createRoundRobinStrategy } from "./moderator/strategies.js";
import type {
  ModeratorContext,
  ModeratorStrategy,
  PriorTurnRecord,
} from "./moderator/strategy.js";
import type { DebateEvent, DebatePhase } from "./types.js";

export type DebateMode = "freeform" | "structured";

/**
 * Context window management config (ROADMAP §2.6). All fields are
 * optional — omit `contextConfig` entirely for the legacy behaviour
 * of forwarding every prior turn verbatim to the strategy.
 */
export interface ContextConfig {
  readonly visibility?: VisibilityConfig;
  readonly summarizer?: SummarizerConfig;
  /**
   * Hard cap on total verbatim prior-turn content (chars). When
   * omitted, no truncation is applied — callers must opt in to
   * truncation by setting an explicit value.
   */
  readonly maxPromptChars?: number;
}

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
  /**
   * Pluggable moderator strategy controlling per-round turn order and
   * per-turn prompts in freeform mode (#212). Defaults to round-robin
   * which preserves the historical structural event sequence.
   *
   * Ignored when `mode === "structured"` — that mode uses the fixed
   * 4-phase choreography in `moderator/phase-prompts.ts`.
   */
  readonly strategy?: ModeratorStrategy;

  /**
   * Context window management (ROADMAP §2.6). When omitted, the
   * orchestrator forwards every prior turn verbatim to the strategy
   * with no summary or truncation — the historical behaviour.
   */
  readonly contextConfig?: ContextConfig;
}

/** Default retry backoff per ROADMAP §3.7 — 250ms, then 1s. */
const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [250, 1000];

interface RunCounters {
  premiumRequests: number;
  estimatedTotal: number;
}

export interface HumanDebateOptions {
  /** Slugs of participants that are human (not AI). */
  readonly humanSlugs?: ReadonlySet<string> | undefined;
  /** Provider for collecting human input. Required when humanSlugs is non-empty. */
  readonly humanInput?: HumanInputProvider | undefined;
}

export class Debate {
  readonly #humanSlugs: ReadonlySet<string>;
  readonly #humanInput: HumanInputProvider | undefined;

  constructor(
    private readonly engine: CouncilEngine,
    private readonly experts: readonly ExpertSpec[],
    private readonly config: DebateConfig,
    humanOpts?: HumanDebateOptions,
  ) {
    this.#humanSlugs = humanOpts?.humanSlugs ?? new Set();
    this.#humanInput = humanOpts?.humanInput;
  }

  async *run(prompt: string): AsyncIterable<DebateEvent> {
    yield {
      kind: "panel.assembled",
      experts: this.experts.map((e) => ({
        slug: e.slug,
        displayName: e.displayName,
        model: e.model,
        ...(this.#humanSlugs.has(e.slug) ? { participantKind: "human" as const } : {}),
      })),
    };

    if (this.config.mode === "structured") {
      yield* this.#runStructured(prompt);
    } else {
      yield* this.#runFreeform(prompt);
    }
  }

  // -------------- Freeform mode (§1.8 + #212 strategy wiring) --------------

  async *#runFreeform(prompt: string): AsyncGenerator<DebateEvent> {
    const strategy = this.config.strategy ?? createRoundRobinStrategy();
    const counters: RunCounters = {
      premiumRequests: 0,
      estimatedTotal: this.experts.length * this.config.maxRounds,
    };

    const priorTurns: PriorTurnRecord[] = [];
    const contextConfig = this.config.contextConfig;

    // Per-round cached summary. Computed once at the top of each round
    // (so the LLM mode incurs at most one extra send per round, not per
    // turn) and reused by every buildCtx() call within that round.
    let cachedRoundSummary = "";
    // Pick the summarizer mode: explicit `mode` from config wins; when
    // omitted, default to "llm" because the orchestrator always has an
    // engine handle. CLI users opt out with --heuristic-summaries.
    const summarizerMode: "llm" | "heuristic" =
      contextConfig?.summarizer?.mode ?? "llm";

    // Build a ModeratorContext for the current `round`, applying the
    // configured visibility filter, prompt-char cap, and rolling
    // summary. When `contextConfig` is undefined the orchestrator
    // forwards every prior turn verbatim with no filtering, no cap,
    // and no summary — the documented legacy behaviour.
    const buildCtx = (round: number): ModeratorContext => {
      if (contextConfig === undefined) {
        return {
          experts: this.experts,
          round,
          maxRounds: this.config.maxRounds,
          topic: prompt,
          priorTurns,
        };
      }

      const scopedTurns = contextConfig.visibility
        ? filterPriorTurns(priorTurns, "", round, contextConfig.visibility)
        : priorTurns;

      const cappedTurns =
        contextConfig.maxPromptChars !== undefined
          ? capByChars(scopedTurns, contextConfig.maxPromptChars)
          : scopedTurns;

      const rollingSummary = contextConfig.summarizer
        ? summarizerMode === "llm"
          ? cachedRoundSummary
          : buildHeuristicSummary(priorTurns, round, contextConfig.summarizer)
        : "";

      return {
        experts: this.experts,
        round,
        maxRounds: this.config.maxRounds,
        topic: prompt,
        priorTurns: cappedTurns,
        ...(rollingSummary !== "" ? { rollingSummary } : {}),
      };
    };

    for (let round = 0; round < this.config.maxRounds; round++) {
      // Refresh the per-round LLM summary cache before any planning
      // happens so buildCtx() returns a stable summary for this round.
      // Heuristic mode keeps its sync per-turn behaviour via buildCtx().
      if (
        summarizerMode === "llm" &&
        contextConfig?.summarizer !== undefined
      ) {
        const moderatorModel =
          this.config.moderatorModel ?? this.experts[0]?.model ?? "default";
        try {
          cachedRoundSummary = await buildLLMSummary(
            priorTurns,
            round,
            contextConfig.summarizer,
            this.engine,
            moderatorModel,
          );
        } catch {
          // Defense-in-depth: buildLLMSummary already swallows engine
          // errors, but never let an optional summary abort the debate.
          cachedRoundSummary = "";
        }
      }

      // First plan locks the round's turn ordering and serves as the
      // shouldContinue() / validation context.
      const initialCtx = buildCtx(round);

      // After the first round, allow the strategy to terminate early
      // (e.g. consensus detected). Round 0 always runs.
      if (round > 0 && !strategy.shouldContinue(initialCtx)) {
        yield { kind: "debate.end", reason: "consensus" };
        return;
      }

      yield { kind: "round.start", round };
      const initialAssignments = strategy.planRound(initialCtx);

      const validationError = validateAssignments(initialAssignments, this.experts);
      if (validationError !== null) {
        yield {
          kind: "error",
          expertSlug: validationError.expertSlug,
          message: `ModeratorStrategy "${strategy.name}" produced an invalid round ${round}: ${validationError.reason}`,
          recoverable: false,
        };
        yield { kind: "round.end", round };
        continue;
      }

      let seq = 0;
      for (let i = 0; i < initialAssignments.length; i++) {
        const initialAssignment = initialAssignments[i];
        if (initialAssignment === undefined) {
          seq += 1;
          continue;
        }
        const expert = this.experts.find((e) => e.slug === initialAssignment.expertSlug);
        if (!expert) {
          // Unreachable: validateAssignments() above already rejected
          // unknown slugs. Defensive guard so a future refactor can't
          // silently drop turns.
          seq += 1;
          continue;
        }

        // Re-plan per-turn (only when contextConfig is set) so the
        // visibility/cap/summary policy sees turns that completed
        // earlier in THIS round. The first turn re-uses the initial
        // plan since priorTurns hasn't changed yet.
        let prompt = initialAssignment.prompt;
        if (contextConfig !== undefined && i > 0) {
          const perTurnCtx = buildCtx(round);
          const perTurnPlan = strategy.planRound(perTurnCtx);
          const refreshed = perTurnPlan.find((a) => a.expertSlug === expert.slug);
          if (refreshed !== undefined) prompt = refreshed.prompt;
        }

        const captured = yield* this.#runTurn(
          expert,
          prompt,
          round,
          seq,
          counters,
        );

        if (captured !== null) {
          priorTurns.push({
            expertSlug: expert.slug,
            displayName: expert.displayName,
            content: captured,
            round,
          });
        }
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
    const isHuman = this.#humanSlugs.has(expert.slug);
    const speakerKind = isHuman ? ("human" as const) : ("expert" as const);

    yield { kind: "turn.start", expertSlug: expert.slug, round, seq, speakerKind };

    if (isHuman) {
      return yield* this.#runHumanTurn(expert, prompt, round, seq, counters);
    }

    return yield* this.#runAiTurn(expert, prompt, round, seq, counters);
  }

  async *#runHumanTurn(
    expert: ExpertSpec,
    prompt: string,
    round: number,
    seq: number,
    counters: RunCounters,
  ): AsyncGenerator<DebateEvent, string | null> {
    if (!this.#humanInput) {
      yield {
        kind: "error",
        expertSlug: expert.slug,
        message: "No HumanInputProvider configured for human participant",
        recoverable: false,
      };
      // No premium request for human turns
      yield {
        kind: "cost.update",
        premiumRequests: counters.premiumRequests,
        estimatedTotal: counters.estimatedTotal,
      };
      return null;
    }

    const result = await this.#humanInput.getInput({
      expertSlug: expert.slug,
      displayName: expert.displayName,
      round,
      seq,
      prompt,
    });

    if (result.kind === "cancelled") {
      yield {
        kind: "error",
        expertSlug: expert.slug,
        message: `Human input cancelled${result.reason ? `: ${result.reason}` : ""}`,
        recoverable: false,
      };
      yield {
        kind: "cost.update",
        premiumRequests: counters.premiumRequests,
        estimatedTotal: counters.estimatedTotal,
      };
      return null;
    }

    const turnId = ulid();
    yield { kind: "turn.delta", expertSlug: expert.slug, text: result.content, speakerKind: "human" };
    yield { kind: "turn.end", expertSlug: expert.slug, turnId, content: result.content, speakerKind: "human" };

    // Human turns do NOT count as premium requests
    yield {
      kind: "cost.update",
      premiumRequests: counters.premiumRequests,
      estimatedTotal: counters.estimatedTotal,
    };

    return result.content;
  }

  async *#runAiTurn(
    expert: ExpertSpec,
    prompt: string,
    _round: number,
    _seq: number,
    counters: RunCounters,
  ): AsyncGenerator<DebateEvent, string | null> {

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
              yield { kind: "turn.delta", expertSlug: expert.slug, text: evt.text, speakerKind: "expert" };
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
      yield { kind: "turn.end", expertSlug: expert.slug, turnId, content, speakerKind: "expert" };
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

/**
 * Truncate the oldest entries from `turns` until total content length
 * fits within `maxChars`. Always preserves the most recent turn even
 * if it alone exceeds the cap (callers can detect this by comparing
 * the returned array's total length vs `maxChars`).
 *
 * Implementation: walks the input once in reverse, accumulating the
 * newest-first slice that fits, then returns the corresponding tail
 * of the original array. O(n) time, O(1) extra allocations beyond
 * the result slice — no quadratic `unshift()`.
 */
function capByChars(
  turns: readonly PriorTurnRecord[],
  maxChars: number,
): readonly PriorTurnRecord[] {
  if (turns.length === 0) return turns;
  let total = 0;
  for (const t of turns) total += t.content.length;
  if (total <= maxChars) return turns;

  let running = 0;
  let cutIndex = turns.length; // exclusive: items at >= cutIndex are kept
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t === undefined) continue;
    const next = running + t.content.length;
    // Always keep the newest turn even if it alone exceeds the cap.
    if (cutIndex < turns.length && next > maxChars) break;
    cutIndex = i;
    running = next;
  }
  return turns.slice(cutIndex);
}

interface AssignmentValidationError {
  readonly expertSlug: string;
  readonly reason: string;
}

/**
 * Validates that a strategy's `planRound()` output is well-formed:
 *
 *   1. Every assigned slug refers to a real panel expert.
 *   2. No slug appears more than once in a single round (a strategy
 *      cannot make the same expert speak twice in the same round).
 *   3. The total number of assignments does not exceed the panel size
 *      (an upper bound that catches accidental duplicates or padding).
 *
 * Returns `null` when the batch is valid, otherwise the first violation.
 */
function validateAssignments(
  assignments: readonly { readonly expertSlug: string }[],
  experts: readonly ExpertSpec[],
): AssignmentValidationError | null {
  if (assignments.length > experts.length) {
    return {
      expertSlug: assignments[experts.length]?.expertSlug ?? "<unknown>",
      reason: `returned ${assignments.length} assignments for a panel of ${experts.length} expert${experts.length === 1 ? "" : "s"}`,
    };
  }

  const knownSlugs = new Set(experts.map((e) => e.slug));
  const seen = new Set<string>();
  for (const a of assignments) {
    if (!knownSlugs.has(a.expertSlug)) {
      return {
        expertSlug: a.expertSlug,
        reason: `returned an assignment for unknown expert slug "${a.expertSlug}"`,
      };
    }
    if (seen.has(a.expertSlug)) {
      return {
        expertSlug: a.expertSlug,
        reason: `returned a duplicate assignment for expert slug "${a.expertSlug}"`,
      };
    }
    seen.add(a.expertSlug);
  }
  return null;
}

/** Re-export for callers consuming both the orchestrator and event types. */
export type { DebateEvent } from "./types.js";
