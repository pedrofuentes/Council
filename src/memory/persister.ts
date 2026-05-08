/**
 * DebatePersister — bridges Debate's event stream to the persistence layer.
 *
 * The Debate orchestrator (src/core/debate.ts) emits a `DebateEvent`
 * stream and stays free of I/O concerns. The persister wraps that stream:
 * for every event it receives, it (a) writes the appropriate row(s) to
 * the database, then (b) yields the event unchanged. Consumers
 * (renderers, cost limiters) downstream of the persister can therefore
 * assume that any event they observe corresponds to a row in the DB.
 *
 * **Single-use** (#120): each `DebatePersister` instance services exactly
 * one debate. A second `persist()` call on the same instance throws with
 * a clear "single-use" message. Construct a fresh persister per debate.
 *
 * What gets persisted:
 *
 *   - On `persist()` entry (BEFORE the first event is yielded): one
 *     `debates` row with status='running', the user prompt, and the
 *     moderator strategy name.
 *   - On `turn.start`: the persister tracks (round, seq) so the matching
 *     `turn.end` can write a turn row with the correct ordering.
 *   - On `turn.end`: one `turns` row with debate_id, round, seq,
 *     speaker_kind='expert', expert_id (looked up via expertSlugToId).
 *     Unmapped slugs are silently skipped — the persister logs nothing.
 *     The orchestrator still tracks the turn; only the persisted side
 *     effect is dropped.
 *   - On `debate.end`: updates the debate row with status='completed'
 *     (or 'aborted'/'failed' depending on the reason) and ended_at.
 *
 * **Observability** (#119): a `turn.end` event with no matching prior
 * `turn.start` indicates an orchestrator protocol violation that should
 * never happen in normal operation. When `deps.logger` is provided, the
 * persister calls `logger.warn(...)` with the offending slug so
 * regressions are detectable. The default behavior (no logger) silently
 * drops the orphan event — same as before.
 *
 * Failure handling:
 *
 *   - Errors from repository calls are NOT swallowed — they bubble out
 *     of the async generator and terminate the stream. Renderers that
 *     want to keep going past a DB error must wrap persist() in their
 *     own try/catch.
 *   - The orchestrator never emits `turn.end` on a failed turn, so failed
 *     expert responses don't get a row. (Surfacing failed turns is
 *     follow-up work — see issue series filed against PR #106.)
 *
 * Why a class with a public `debateId` getter rather than a function:
 * tests + callers need to inspect the created debate row id without
 * waiting for the stream to drain.
 */
import type { DebateEndReason, DebateEvent } from "../core/types.js";

import type { DebateRepository, DebateStatus } from "./repositories/debates.js";
import type { TurnRepository } from "./repositories/turns.js";

/**
 * Minimal logger surface used by `DebatePersister` for orchestrator
 * protocol-violation warnings (#119). Production callers can pass a
 * console-backed implementation; tests pass a Vitest mock.
 *
 * Why not pull in a full logging library: the persister has exactly one
 * logging need today (warn on orphan turn.end), and a 2-line interface
 * keeps the dependency surface zero.
 */
export interface DebatePersisterLogger {
  warn(message: string): void;
}

export interface DebatePersisterDeps {
  readonly debates: DebateRepository;
  readonly turns: TurnRepository;
  readonly panelId: string;
  /** Maps `ExpertSpec.slug` (used in events) → `experts.id` (FK target). */
  readonly expertSlugToId: Readonly<Record<string, string>>;
  /** Moderator strategy name written verbatim to `debates.moderator`. */
  readonly moderator: string;
  /**
   * Optional logger for orchestrator protocol-violation warnings (#119).
   * When omitted, violations are silently swallowed (legacy behavior).
   */
  readonly logger?: DebatePersisterLogger;
}

interface TurnPosition {
  readonly round: number;
  readonly seq: number;
}

function reasonToStatus(reason: DebateEndReason): DebateStatus {
  switch (reason) {
    case "completed":
    case "consensus":
    case "limit":
      return "completed";
    case "aborted":
      return "aborted";
    case "failed":
      return "failed";
  }
}

export class DebatePersister {
  #debateId: string | undefined;
  // Tracks the (round, seq) for the currently-streaming turn per expert
  // so turn.end (which lacks round/seq) can write the correct row.
  readonly #pendingTurnPosition = new Map<string, TurnPosition>();

  constructor(private readonly deps: DebatePersisterDeps) {}

  /** ID of the debate row created on persist() entry, or undefined before. */
  get debateId(): string | undefined {
    return this.#debateId;
  }

  /**
   * Wraps `source` — the output of `Debate.run()` — and yields each event
   * unchanged after persisting the appropriate side effects.
   *
   * #117: on abnormal exit BEFORE any debate.end (source throws OR
   * consumer breaks the for-await loop), the wrapped iterator's `finally`
   * marks the debate row as `status='aborted'` with `endedAt` set. Without
   * this, the row would stay at `status='running'` forever, breaking the
   * resumable/abandoned distinction §3.2 session-resume needs.
   *
   * #150: once the terminal `debate.end` update is ATTEMPTED (success or
   * failure), the `finally` block must NOT touch the row. If the terminal
   * update succeeded, the row is final ('completed'/'aborted'/etc.). If
   * it failed, the row stays at its pre-attempt state ('running') and the
   * thrown error bubbles to the caller — that is the truthful state.
   * Previously the finally would silently overwrite the row to 'aborted'
   * AND swallow the second error via .catch(), masking the original
   * failure as if the debate had been aborted.
   */
  async *persist(source: AsyncIterable<DebateEvent>, prompt: string): AsyncIterable<DebateEvent> {
    // #120: enforce single-use. A second persist() call on the same
    // instance would silently overwrite #debateId and let pendingTurn
    // state from the first debate leak into the second. Construct a
    // fresh persister per debate; this throws if reuse is attempted.
    if (this.#debateId !== undefined) {
      throw new Error(
        "DebatePersister is single-use: persist() may only be called once per instance. Construct a fresh persister for each debate.",
      );
    }

    const debate = await this.deps.debates.create({
      panelId: this.deps.panelId,
      prompt,
      moderator: this.deps.moderator,
    });
    this.#debateId = debate.id;

    let terminalUpdateAttempted = false;
    try {
      for await (const evt of source) {
        switch (evt.kind) {
          case "turn.start": {
            this.#pendingTurnPosition.set(evt.expertSlug, { round: evt.round, seq: evt.seq });
            break;
          }
          case "turn.end": {
            await this.#persistTurn(evt.expertSlug, evt.content);
            this.#pendingTurnPosition.delete(evt.expertSlug);
            break;
          }
          case "debate.end": {
            // #150: mark the attempt BEFORE the await so a thrown
            // update doesn't trigger the finally's abort-overwrite.
            terminalUpdateAttempted = true;
            await this.deps.debates.update(debate.id, {
              status: reasonToStatus(evt.reason),
              endedAt: new Date().toISOString(),
            });
            break;
          }
          default:
            // panel.assembled, round.start/end, turn.delta, cost.update,
            // error — passthrough only, no persistence side effect at the
            // debate/turn level. (Per-event logging lands in §3.6 export.)
            break;
        }
        yield evt;
      }
    } finally {
      if (!terminalUpdateAttempted) {
        // Source threw before debate.end OR consumer broke the loop —
        // finalize so session-resume can distinguish abandoned from running.
        // Best-effort: we're already in a failure path, so swallow any
        // DB error here rather than masking the original throw.
        await this.deps.debates
          .update(debate.id, {
            status: "aborted",
            endedAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
    }
  }

  async #persistTurn(expertSlug: string, content: string): Promise<void> {
    const expertId = this.deps.expertSlugToId[expertSlug];
    if (!expertId || !this.#debateId) return;
    const pos = this.#pendingTurnPosition.get(expertSlug);
    if (!pos) {
      // #119: turn.end without a matching turn.start signals an
      // orchestrator protocol violation. Warn (when a logger is
      // configured) so regressions are detectable; otherwise drop
      // silently to preserve backwards-compatible default behavior.
      this.deps.logger?.warn(
        `DebatePersister: turn.end for slug='${expertSlug}' has no matching turn.start (orchestrator protocol violation; turn row dropped)`,
      );
      return;
    }
    await this.deps.turns.create({
      debateId: this.#debateId,
      round: pos.round,
      seq: pos.seq,
      speakerKind: "expert",
      expertId,
      content,
    });
  }
}
