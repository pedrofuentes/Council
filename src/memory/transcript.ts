/**
 * Transcript helper — loads a panel + selected debate + turns from
 * SQLite into a `TranscriptDocument`, and synthesizes a stream of
 * `DebateEvent`s from it.
 *
 * Shared by:
 *   - `council resume <panel>` (transcript mode) — read-only review
 *   - `council export <panel>` (markdown / json / adr) — share/archive
 *
 * Pure read path: no engine, no LLM, no persistence side effects.
 *
 * Why a separate module (not inline in each command):
 *   - Both consumers need the same DB → events shape, and any drift
 *     between them produces user-visible inconsistencies (resume vs
 *     export showing different turn ordering, status reasons, etc.).
 *   - Pulls the synthesis logic (round bracketing, expert-id → slug
 *     resolution, status → DebateEndReason mapping) out of CLI code
 *     into a unit-testable module.
 *   - Sentinel pr165 #2 flagged the duplication risk preemptively;
 *     this extraction closes the synthesis half of that concern.
 */
import type { DebateEvent, DebateEndReason, PanelMemberSnapshot } from "../core/types.js";

import type { CouncilDatabase } from "./db.js";
import type { Panel } from "./repositories/panels.js";
import { PanelRepository } from "./repositories/panels.js";
import { type Expert, ExpertRepository } from "./repositories/experts.js";
import { DebateRepository, type Debate, type DebateStatus } from "./repositories/debates.js";
import { TurnRepository, type Turn } from "./repositories/turns.js";

export interface TranscriptDocument {
  readonly panel: Panel;
  readonly experts: readonly Expert[];
  readonly originalPrompt: string;
  readonly latestDebate: {
    readonly id: string;
    readonly prompt: string;
    readonly status: DebateStatus;
    readonly startedAt: string;
    readonly endedAt: string | null;
  };
  readonly turns: readonly Turn[];
}

/**
 * Resolve a panel by name and load either an explicit debate or the
 * panel's most substantive debate (highest turn count; latest wins ties)
 * plus that debate's turns. Throws with a clear, user-actionable
 * message when the panel is missing or has no debates yet.
 *
 * Name lookup uses `PanelRepository.findByName()` (most-recent wins on
 * collision; see Sentinel pr165 #4 for ambiguity-warning follow-up).
 */
export async function loadTranscript(
  db: CouncilDatabase,
  panelName: string,
  debateId?: string,
): Promise<TranscriptDocument> {
  const panelRepo = new PanelRepository(db);
  const expertRepo = new ExpertRepository(db);
  const debateRepo = new DebateRepository(db);
  const turnRepo = new TurnRepository(db);

  const panel = await panelRepo.findByName(panelName);
  if (!panel) {
    throw new Error(
      `No panel found with name '${panelName}'. Run \`council sessions\` to list available panels.`,
    );
  }
  const experts = await expertRepo.findByPanelId(panel.id);
  const debates = await debateRepo.findByPanelId(panel.id);
  if (debates.length === 0) {
    throw new Error(
      `Panel '${panelName}' has no debates yet. Run \`council convene\` to start one.`,
    );
  }

  const originalDebate = debates[0];
  if (!originalDebate) {
    throw new Error(
      `Panel '${panelName}' has no debates yet. Run \`council convene\` to start one.`,
    );
  }

  const latest =
    debateId === undefined
      ? await selectMostSubstantiveDebate(db, debates)
      : debates.find((debate) => debate.id === debateId);
  if (!latest) {
    throw new Error(
      `No debate found with id '${debateId}' for panel '${panelName}'. Run \`council sessions\` to inspect available debates.`,
    );
  }

  const turns = await turnRepo.findByDebateId(latest.id);
  return {
    panel,
    experts,
    originalPrompt: originalDebate.prompt,
    latestDebate: {
      id: latest.id,
      prompt: latest.prompt,
      status: latest.status,
      startedAt: latest.startedAt,
      endedAt: latest.endedAt,
    },
    turns,
  };
}

async function selectMostSubstantiveDebate(
  db: CouncilDatabase,
  debates: readonly Debate[],
): Promise<Debate> {
  const countRows = await db
    .selectFrom("turns")
    .select("debate_id")
    .select((eb) => eb.fn.countAll<number>().as("turn_count"))
    .where(
      "debate_id",
      "in",
      debates.map((debate) => debate.id),
    )
    .groupBy("debate_id")
    .execute();

  const turnCountByDebateId = new Map<string, number>();
  for (const row of countRows) {
    turnCountByDebateId.set(row.debate_id, Number(row.turn_count));
  }

  let selected = debates[0];
  if (!selected) {
    throw new Error("selectMostSubstantiveDebate() requires at least one debate.");
  }
  let selectedTurnCount = turnCountByDebateId.get(selected.id) ?? 0;

  for (const debate of debates.slice(1)) {
    const turnCount = turnCountByDebateId.get(debate.id) ?? 0;
    if (turnCount > selectedTurnCount || turnCount === selectedTurnCount) {
      selected = debate;
      selectedTurnCount = turnCount;
    }
  }

  return selected;
}

/**
 * Map persisted `DebateStatus` to the `DebateEndReason` the renderer
 * expects on the terminal `debate.end` event.
 *
 * `running` (debate was abandoned mid-stream — no terminal event ever
 * fired) maps to `aborted` so consumers can distinguish from cleanly
 * completed debates without inventing a new event variant.
 */
function reasonFromStatus(status: DebateStatus): DebateEndReason {
  switch (status) {
    case "completed":
      return "completed";
    case "aborted":
      return "aborted";
    case "failed":
      return "failed";
    case "running":
      return "aborted";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/**
 * Reconstruct a `DebateEvent[]` from a `TranscriptDocument`.
 *
 * Shape mirrors what `Debate.run()` would emit live:
 *   panel.assembled
 *   round.start (if any turns)
 *     turn.start
 *     turn.end
 *     ...
 *   round.end
 *   ...repeat per round...
 *   debate.end (reason mapped from persisted status)
 *
 * Zero-turn debates emit only `panel.assembled` + `debate.end`. Turns
 * with no resolvable `expertId` slug fall back to their `speakerKind`
 * (e.g. `"system"`) — matches resume's plain-mode fallback so the two
 * commands behave the same on edge data.
 */
export function synthesizeEvents(doc: TranscriptDocument): DebateEvent[] {
  const slugById = new Map<string, string>();
  for (const e of doc.experts) slugById.set(e.id, e.slug);

  const members: PanelMemberSnapshot[] = doc.experts.map((e) => ({
    slug: e.slug,
    displayName: e.displayName,
    model: e.model,
  }));
  const events: DebateEvent[] = [{ kind: "panel.assembled", experts: members }];

  let lastRound = -1;
  for (const t of doc.turns) {
    if (t.round !== lastRound) {
      if (lastRound !== -1) events.push({ kind: "round.end", round: lastRound });
      events.push({ kind: "round.start", round: t.round });
      lastRound = t.round;
    }
    const slug = t.expertId ? (slugById.get(t.expertId) ?? t.speakerKind) : t.speakerKind;
    events.push({ kind: "turn.start", expertSlug: slug, round: t.round, seq: t.seq });
    events.push({ kind: "turn.end", expertSlug: slug, turnId: t.id, content: t.content });
  }
  if (lastRound !== -1) events.push({ kind: "round.end", round: lastRound });
  events.push({ kind: "debate.end", reason: reasonFromStatus(doc.latestDebate.status) });

  return events;
}
