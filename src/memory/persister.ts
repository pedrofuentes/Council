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

export interface DebatePersisterDeps {
  readonly debates: DebateRepository;
  readonly turns: TurnRepository;
  readonly panelId: string;
  /** Maps `ExpertSpec.slug` (used in events) → `experts.id` (FK target). */
  readonly expertSlugToId: Readonly<Record<string, string>>;
  /** Moderator strategy name written verbatim to `debates.moderator`. */
  readonly moderator: string;
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
   */
  async *persist(source: AsyncIterable<DebateEvent>, prompt: string): AsyncIterable<DebateEvent> {
    const debate = await this.deps.debates.create({
      panelId: this.deps.panelId,
      prompt,
      moderator: this.deps.moderator,
    });
    this.#debateId = debate.id;

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
  }

  async #persistTurn(expertSlug: string, content: string): Promise<void> {
    const expertId = this.deps.expertSlugToId[expertSlug];
    if (!expertId || !this.#debateId) return;
    const pos = this.#pendingTurnPosition.get(expertSlug);
    if (!pos) return;
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
