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
 *   - On `turn.start`: the persister tracks (round, seq) and buffers any
 *     subsequent `turn.delta` chunks so the matching `turn.end` can write a
 *     turn row with the correct ordering, or SIGINT can flush a partial turn.
 *   - On `turn.end`: one `turns` row with debate_id, round, seq,
 *     speaker_kind='expert', expert_id (looked up via expertSlugToId).
 *     Unmapped slugs are silently skipped — the persister logs nothing.
 *     The orchestrator still tracks the turn; only the persisted side
 *     effect is dropped.
 *   - On `debate.end`: updates the debate row with status='completed'
 *     (or 'interrupted'/'aborted'/'failed' depending on the reason and
 *     signal state) and ended_at.
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
   * AbortSignal from the CLI's SIGINT handler. When aborted mid-turn,
   * the persister flushes buffered deltas as a partial turn and marks
   * the debate row `interrupted` instead of generic `aborted`.
   */
  readonly signal?: AbortSignal;
  /**
   * Optional logger for orchestrator protocol-violation warnings (#119).
   * When omitted, violations are silently swallowed (legacy behavior).
   */
  readonly logger?: DebatePersisterLogger;
}

interface PendingTurn {
  round: number;
  seq: number;
  speakerKind: "expert" | "human";
  content: string;
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
  // Tracks the currently-streaming turn per expert so turn.end can write the
  // correct row, and so a SIGINT-aborted turn can flush buffered deltas as a
  // partial final turn before the debate is marked interrupted.
  readonly #pendingTurns = new Map<string, PendingTurn>();

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
   * marks the debate row as terminal. Without this, the row would stay at
   * `status='running'` forever, breaking resume semantics.
   *
   * #150: once the terminal `debate.end` update is ATTEMPTED (success or
   * failure), the `finally` block must NOT touch the row. If the terminal
   * update succeeded, the row is final. If it failed, the row stays at its
   * pre-attempt state ('running') and the thrown error bubbles to the caller.
   */
  async *persist(source: AsyncIterable<DebateEvent>, prompt: string): AsyncIterable<DebateEvent> {
    // #120: enforce single-use. A second persist() call on the same
    // instance would silently overwrite #debateId and let pending-turn
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
    let sourceError: unknown;
    let interruptedFinalizationError: unknown;
    try {
      for await (const evt of source) {
        switch (evt.kind) {
          case "turn.start": {
            this.#pendingTurns.set(evt.expertSlug, {
              round: evt.round,
              seq: evt.seq,
              speakerKind: evt.speakerKind ?? "expert",
              content: "",
            });
            break;
          }
          case "turn.delta": {
            const pending = this.#pendingTurns.get(evt.expertSlug);
            if (pending) {
              pending.content += evt.text;
              pending.speakerKind = evt.speakerKind ?? pending.speakerKind;
            }
            break;
          }
          case "turn.end": {
            await this.#persistTurn(evt.expertSlug, evt.content, evt.speakerKind ?? "expert");
            this.#pendingTurns.delete(evt.expertSlug);
            break;
          }
          case "debate.end": {
            if (evt.reason === "aborted" && this.#isInterruptedSignal()) {
              await this.#flushPendingTurns();
            }
            // #150: mark the attempt BEFORE the await so a thrown
            // update doesn't trigger the finally's abort-overwrite.
            terminalUpdateAttempted = true;
            await this.deps.debates.update(debate.id, {
              status: this.#terminalStatus(evt.reason),
              endedAt: new Date().toISOString(),
            });
            break;
          }
          default:
            // panel.assembled, round.start/end, cost.update, error, turn.retry —
            // passthrough only, no persistence side effect at the debate/turn level.
            break;
        }
        yield evt;
      }
    } catch (error: unknown) {
      sourceError = error;
    } finally {
      if (!terminalUpdateAttempted) {
        // Source threw before debate.end OR consumer broke the loop —
        // finalize so session-resume can distinguish abandoned from running.
        if (this.#isInterruptedSignal()) {
          try {
            await this.#finalizeAbruptExit(debate.id);
          } catch (error: unknown) {
            interruptedFinalizationError = error;
          }
        } else {
          try {
            await this.#finalizeAbruptExit(debate.id);
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.logger?.warn(
              `DebatePersister: finalizeAbruptExit failed for debateId='${debate.id}': ${message}`,
            );
          }
        }
      }
    }

    if (interruptedFinalizationError !== undefined) {
      if (sourceError !== undefined) {
        throw new AggregateError(
          [sourceError, interruptedFinalizationError],
          `DebatePersister: finalizeAbruptExit failed for debateId='${debate.id}'`,
        );
      }
      throw interruptedFinalizationError;
    }

    if (sourceError !== undefined) {
      throw sourceError;
    }
  }

  #isInterruptedSignal(): boolean {
    return this.deps.signal?.aborted === true;
  }

  #terminalStatus(reason: DebateEndReason): DebateStatus {
    if (reason === "aborted" && this.#isInterruptedSignal()) {
      return "interrupted";
    }
    return reasonToStatus(reason);
  }

  async #finalizeAbruptExit(debateId: string): Promise<void> {
    if (this.#isInterruptedSignal()) {
      await this.#flushPendingTurns();
    }
    await this.deps.debates.update(debateId, {
      status: this.#isInterruptedSignal() ? "interrupted" : "aborted",
      endedAt: new Date().toISOString(),
    });
  }

  async #flushPendingTurns(): Promise<void> {
    const pendingTurns = [...this.#pendingTurns.entries()];
    for (const [expertSlug, pending] of pendingTurns) {
      // We reuse the normal turns table and let the interrupted debate status
      // carry the "incomplete" meaning for the final persisted partial turn.
      if (pending.content.length > 0) {
        await this.#persistPendingTurn(expertSlug, pending, pending.content, pending.speakerKind);
      }
      this.#pendingTurns.delete(expertSlug);
    }
  }

  async #persistTurn(
    expertSlug: string,
    content: string,
    speakerKind: "expert" | "human" = "expert",
  ): Promise<void> {
    const pending = this.#pendingTurns.get(expertSlug);
    if (!pending) {
      // #119: turn.end without a matching turn.start signals an
      // orchestrator protocol violation. Warn (when a logger is
      // configured) so regressions are detectable; otherwise drop
      // silently to preserve backwards-compatible default behavior.
      this.deps.logger?.warn(
        `DebatePersister: turn.end for slug='${expertSlug}' has no matching turn.start (orchestrator protocol violation; turn row dropped)`,
      );
      return;
    }
    await this.#persistPendingTurn(expertSlug, pending, content, speakerKind);
  }

  async #persistPendingTurn(
    expertSlug: string,
    pending: PendingTurn,
    content: string,
    speakerKind: "expert" | "human",
  ): Promise<void> {
    const expertId = this.deps.expertSlugToId[expertSlug];
    if (!expertId || !this.#debateId) return;
    await this.deps.turns.create({
      debateId: this.#debateId,
      round: pending.round,
      seq: pending.seq,
      speakerKind,
      expertId,
      content,
    });
  }
}
