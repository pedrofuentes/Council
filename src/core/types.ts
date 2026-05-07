/**
 * Council core domain types.
 *
 * `DebateEvent` is the single event stream that flows out of `Debate.run()`
 * and is consumed by every renderer (Ink, JSON, Plain), the persistence
 * layer (writes turn rows on `turn.end`), and the cost limiter.
 *
 * The streaming shape is one `AsyncIterable<DebateEvent>` per debate. Per
 * AGENTS.md / ROADMAP, this single stream avoids coupling between
 * consumers — each subscribes by filtering the discriminator (`kind`).
 */

/** Snapshot of a panel member emitted at the start of a debate. */
export interface PanelMemberSnapshot {
  readonly slug: string;
  readonly displayName: string;
  readonly model: string;
}

/** Why a debate ended. */
export type DebateEndReason = "completed" | "consensus" | "aborted" | "limit" | "failed";

/**
 * Events emitted by `Debate.run()` in temporal order.
 *
 * Within a round, exactly one expert speaks at a time:
 *   round.start
 *     turn.start (expertSlug=A)
 *     turn.delta+ (expertSlug=A)
 *     turn.end (expertSlug=A)
 *     cost.update (after each turn)
 *     turn.start (expertSlug=B) ...
 *   round.end
 *
 * `error` events may appear in place of (or interleaved before) the
 * matching `turn.end`. Errors are non-terminal at the debate level —
 * the orchestrator continues with the next expert / round.
 */
export type DebateEvent =
  | {
      readonly kind: "panel.assembled";
      readonly experts: readonly PanelMemberSnapshot[];
    }
  | {
      readonly kind: "round.start";
      readonly round: number;
    }
  | {
      readonly kind: "turn.start";
      readonly expertSlug: string;
      readonly round: number;
      readonly seq: number;
    }
  | {
      readonly kind: "turn.delta";
      readonly expertSlug: string;
      readonly text: string;
    }
  | {
      readonly kind: "turn.end";
      readonly expertSlug: string;
      readonly turnId: string;
      readonly content: string;
    }
  | {
      readonly kind: "round.end";
      readonly round: number;
      readonly summary?: string;
    }
  | {
      readonly kind: "cost.update";
      readonly premiumRequests: number;
      readonly estimatedTotal: number;
    }
  | {
      readonly kind: "debate.end";
      readonly reason: DebateEndReason;
    }
  | {
      readonly kind: "error";
      readonly expertSlug?: string;
      readonly message: string;
      readonly recoverable: boolean;
    };
