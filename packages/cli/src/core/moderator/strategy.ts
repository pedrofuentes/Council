/**
 * ModeratorStrategy interface — pluggable turn-ordering and prompt
 * generation for debates (ROADMAP §2.3).
 *
 * Each strategy controls:
 *   1. Which experts speak in what order per round (`planRound`)
 *   2. What prompt each expert receives
 *   3. Whether the debate should continue (`shouldContinue`)
 *
 * Pure interface: strategies are stateless functions that receive
 * context and return assignments. The Debate orchestrator owns state.
 */
import type { ExpertSpec } from "../../engine/index.js";

/** A prior turn from an earlier round, used to build context-aware prompts. */
export interface PriorTurnRecord {
  readonly expertSlug: string;
  readonly displayName: string;
  readonly content: string;
  readonly round: number;
}

/** Context provided to the strategy for each decision point. */
export interface ModeratorContext {
  readonly experts: readonly ExpertSpec[];
  readonly round: number;
  readonly maxRounds: number;
  readonly topic: string;
  readonly priorTurns: readonly PriorTurnRecord[];
  /**
   * Optional rolling summary of earlier rounds (ROADMAP §2.6). Present
   * only when the Debate orchestrator's `contextConfig.summarizer` is
   * configured and the current round is past the threshold. Strategies
   * SHOULD include this in their prompt when present so the model has
   * a compact view of debate history without every verbatim turn.
   */
  readonly rollingSummary?: string;
}

/** An assignment: which expert speaks and what prompt they receive. */
export interface TurnAssignment {
  readonly expertSlug: string;
  readonly prompt: string;
}

/**
 * A moderator strategy determines turn order and per-turn prompts.
 *
 * Strategies are pure (no I/O, no engine calls) so they can be tested
 * deterministically and used offline with MockEngine.
 */
export interface ModeratorStrategy {
  /** Human-readable strategy name (e.g. "round-robin", "devils-advocate"). */
  readonly name: string;

  /**
   * Plan the assignments for a given round. Returns one TurnAssignment
   * per expert that should speak this round (may be fewer than all
   * experts if the strategy skips some).
   */
  planRound(ctx: ModeratorContext): readonly TurnAssignment[];

  /**
   * Whether the debate should continue after the current round.
   * Called after each round completes. Return `false` to end early
   * (e.g. consensus detected).
   */
  shouldContinue(ctx: ModeratorContext): boolean;
}
