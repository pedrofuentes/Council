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
}

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
  ): string | null {
    switch (phase) {
      case "opening":
        return buildOpeningPrompt(topic);
      case "cross-examination":
        return buildCrossExamPrompt(topic, expert, openingTurns);
      case "rebuttal":
        return buildRebuttalPrompt(topic, expert, openingTurns, crossExamTurns);
      case "synthesis":
        return buildSynthesisPrompt(topic, expert, openingTurns, crossExamTurns, []);
    }
  }

  /**
   * Runs one expert's turn end-to-end. Yields all related debate events
   * and returns the accumulated response content (or `null` if the turn
   * failed / errored). Updates `counters.premiumRequests` and emits a
   * `cost.update` after every turn.
   */
  async *#runTurn(
    expert: ExpertSpec,
    prompt: string,
    round: number,
    seq: number,
    counters: RunCounters,
  ): AsyncGenerator<DebateEvent, string | null> {
    yield { kind: "turn.start", expertSlug: expert.slug, round, seq };

    let content = "";
    let turnFailed = false;
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
            turnFailed = true;
            yield {
              kind: "error",
              expertSlug: expert.slug,
              message: evt.error.message,
              recoverable: evt.recoverable,
            };
            break;
          }
        }
      }
    } catch (err: unknown) {
      turnFailed = true;
      yield {
        kind: "error",
        expertSlug: expert.slug,
        message: err instanceof Error ? err.message : String(err),
        recoverable: false,
      };
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

/** Re-export for callers consuming both the orchestrator and event types. */
export type { DebateEvent } from "./types.js";
