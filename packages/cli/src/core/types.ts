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
  /** Participant kind: "expert" for AI, "human" for human participants. */
  readonly participantKind?: "expert" | "human";
}

/** Why a debate ended. */
export type DebateEndReason = "completed" | "consensus" | "aborted" | "limit" | "failed";

/**
 * Phases of a structured debate (ROADMAP §2.2). Only emitted when the
 * debate runs in `mode: "structured"`. Freeform debates emit
 * `round.start` events without a `phase` field.
 */
export type DebatePhase = "opening" | "cross-examination" | "rebuttal" | "synthesis";

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
      /** Present only in structured mode (ROADMAP §2.2). */
      readonly phase?: DebatePhase;
    }
  | {
      readonly kind: "turn.start";
      readonly expertSlug: string;
      readonly round: number;
      readonly seq: number;
      /** "human" for human participants; defaults to "expert" when absent. */
      readonly speakerKind?: "expert" | "human";
    }
  | {
      readonly kind: "turn.delta";
      readonly expertSlug: string;
      readonly text: string;
      /** "human" for human participants; defaults to "expert" when absent. */
      readonly speakerKind?: "expert" | "human";
    }
  | {
      readonly kind: "turn.end";
      readonly expertSlug: string;
      readonly turnId: string;
      readonly content: string;
      /** "human" for human participants; defaults to "expert" when absent. */
      readonly speakerKind?: "expert" | "human";
    }
  | {
      readonly kind: "round.end";
      readonly round: number;
      readonly summary?: string;
      /** Present only in structured mode (ROADMAP §2.2). */
      readonly phase?: DebatePhase;
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
    }
  | {
      /**
       * Emitted when the orchestrator retries a turn after a recoverable
       * engine error (e.g. RATE_LIMITED, NETWORK). One event per retry
       * attempt — `attempt` is 1-indexed (the first retry is attempt=1,
       * which is the 2nd total send for that turn).
       *
       * Renderers MAY display "[expert retrying...]"; if ignored,
       * downstream behavior is identical to a slightly slower turn.
       * Persistence (DebatePersister) does NOT write a row for retries —
       * only the eventual `turn.end` (success) or `error` (exhaustion).
       */
      readonly kind: "turn.retry";
      readonly expertSlug: string;
      readonly attempt: number;
      readonly reason: string;
    }
  | {
      /**
       * Emitted immediately BEFORE a `turn.retry` when a failed attempt has
       * already streamed partial `turn.delta`s (#184). It instructs consumers
       * to DISCARD all accumulated content for this turn so the retry's fresh
       * deltas are not appended to the abandoned attempt's text. Renderers
       * that buffer per-turn content MUST clear it; persistence ignores this
       * event (it only writes on `turn.end`).
       */
      readonly kind: "turn.discard";
      readonly expertSlug: string;
    }
  | {
      /**
       * Emitted when the anti-sycophancy quality gate (see
       * `core/quality-gate.ts`) flags an assembled expert response. The
       * event carries NO response text — only the discriminating metadata
       * renderers need for a concise notice.
       *
       *   - `mode: "warn"`   — the response was flagged but kept as-is
       *     (`action: "warned"`). The orchestrator does NOT regenerate.
       *   - `mode: "regenerate"` — one event per regeneration attempt
       *     (`action: "regenerating"`, 1-indexed `regenerationAttempt`).
       *     If the cap is reached and the response still fails, the last
       *     candidate is accepted with `action: "accepted_after_cap"`.
       *
       * `failures` lists the failing check kinds (e.g. `forbidden_phrase`).
       * `priorSpeakers` is the set of slugs that already spoke this round
       * at gate time (empty for the round's first speaker). Renderers MUST
       * sanitize any model-derived text (e.g. expert display names) before
       * display; persistence ignores this event (it is not a turn).
       */
      readonly kind: "turn.quality_gate";
      readonly expertSlug: string;
      readonly round: number;
      readonly mode: "warn" | "regenerate";
      readonly action: "warned" | "regenerating" | "accepted_after_cap";
      readonly failures: readonly string[];
      readonly regenerationAttempt?: number;
      readonly maxRegenerations?: number;
      readonly priorSpeakers: readonly string[];
    };
