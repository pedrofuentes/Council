/**
 * Debate orchestrator — sequential turn-based panel chat.
 *
 * Implements the freeform mode from ROADMAP §1.8: each round, each expert
 * speaks once in panel order. The orchestrator translates engine events
 * (`message.delta`, `message.complete`, `error`) into Council domain events
 * (`turn.delta`, `turn.end`, `error`) and emits structural events
 * (`panel.assembled`, `round.start`, `round.end`, `cost.update`, `debate.end`).
 *
 * Persistence is OUT OF SCOPE for this PR — consumers wire the stream to
 * `TurnRepository.create()` themselves on `turn.end` events. The
 * orchestrator generates `turnId`s but does not write to the database.
 *
 * Structured mode (Opening → Cross-examination → Rebuttal → Synthesis)
 * lands in a follow-up PR per ROADMAP §2.2; the `mode` field is part of
 * `DebateConfig` here so callers don't have to re-plumb later.
 */
import { ulid } from "ulid";

import type {
  CouncilEngine,
  ExpertSpec,
} from "../engine/index.js";

import type { DebateEndReason, DebateEvent } from "./types.js";

export type DebateMode = "freeform" | "structured";

export interface DebateConfig {
  readonly maxRounds: number;
  readonly maxWordsPerResponse: number;
  readonly mode: DebateMode;
  readonly moderatorModel?: string;
}

export class Debate {
  constructor(
    private readonly engine: CouncilEngine,
    private readonly experts: readonly ExpertSpec[],
    private readonly config: DebateConfig,
  ) {}

  async *run(prompt: string): AsyncIterable<DebateEvent> {
    let premiumRequests = 0;
    const estimatedTotal = this.experts.length * this.config.maxRounds;

    yield {
      kind: "panel.assembled",
      experts: this.experts.map((e) => ({
        slug: e.slug,
        displayName: e.displayName,
        model: e.model,
      })),
    };

    const endReason: DebateEndReason = "completed";

    for (let round = 0; round < this.config.maxRounds; round++) {
      yield { kind: "round.start", round };

      let seq = 0;
      for (const expert of this.experts) {
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
                // Ignore — turn.end is yielded after the loop with the accumulated content.
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

        premiumRequests += 1;
        yield { kind: "cost.update", premiumRequests, estimatedTotal };

        seq += 1;
      }

      yield { kind: "round.end", round };
    }

    yield { kind: "debate.end", reason: endReason };
  }
}

/** Re-export for callers consuming both the orchestrator and event types. */
export type { DebateEvent } from "./types.js";
