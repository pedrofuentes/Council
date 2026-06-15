/**
 * Tests for empty-response retry in the debate/convene path
 * (`Debate.#runAiTurn`) — T14.
 *
 * Behavior:
 *   - When an expert's send completes with empty/whitespace-only content
 *     (no error), the orchestrator retries the send ONCE before giving up.
 *   - If the retry produces content, a normal `turn.end` is emitted with
 *     that content (the empty response is not silently dropped).
 *   - If it's empty again, the orchestrator surfaces a clear `error` event
 *     (recoverable: false) instead of persisting a blank turn, and the
 *     debate continues to the remaining experts and `debate.end`.
 *   - Non-empty responses are unaffected: exactly one send, no retry.
 *
 * RED at this commit: `Debate` has no empty-retry logic, so an empty first
 * response yields a `turn.end` with empty content and never retries.
 */
import { describe, expect, it } from "vitest";

import { Debate, type DebateConfig } from "../../../src/core/debate.js";
import type { DebateEvent } from "../../../src/core/types.js";
import type { ExpertSpec } from "../../../src/engine/index.js";
import { ScriptedEngine } from "../../helpers/scripted-engine.js";

const cto: ExpertSpec = {
  id: "01HZ-cto",
  slug: "cto",
  displayName: "CTO",
  model: "claude-sonnet-4",
  systemMessage: "You are a CTO.",
};

const pm: ExpertSpec = {
  id: "01HZ-pm",
  slug: "pm",
  displayName: "PM",
  model: "claude-sonnet-4",
  systemMessage: "You are a PM.",
};

const FREEFORM_1R: DebateConfig = {
  maxRounds: 1,
  maxWordsPerResponse: 50,
  mode: "freeform",
  retryBackoffMs: [1, 2],
};

async function collect(stream: AsyncIterable<DebateEvent>): Promise<DebateEvent[]> {
  const out: DebateEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

function only<K extends DebateEvent["kind"]>(
  events: readonly DebateEvent[],
  kind: K,
): Extract<DebateEvent, { kind: K }>[] {
  return events.filter((e): e is Extract<DebateEvent, { kind: K }> => e.kind === kind);
}

describe("Debate empty-response retry (T14)", () => {
  it("retries an empty turn once and emits turn.end with the retried content", async () => {
    const engine = new ScriptedEngine({
      scripts: {
        [cto.id]: [
          { kind: "content", text: "" },
          { kind: "content", text: "CTO real answer." },
        ],
      },
    });
    await engine.start();
    await engine.addExpert(cto);

    const events = await collect(new Debate(engine, [cto], FREEFORM_1R).run("topic"));

    // The retry actually fired.
    expect(engine.sendCount(cto.id)).toBe(2);
    expect(only(events, "turn.retry")).toHaveLength(1);

    // The eventual content (not the empty first attempt) is surfaced + kept.
    const turnEnds = only(events, "turn.end");
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.content).toBe("CTO real answer.");

    // No surfaced error — the retry succeeded.
    expect(only(events, "error")).toHaveLength(0);
    expect(only(events, "debate.end")).toHaveLength(1);
  });

  it("surfaces an error and continues when an expert is empty twice, preserving other experts", async () => {
    const engine = new ScriptedEngine({
      scripts: {
        [cto.id]: [
          { kind: "content", text: "" },
          { kind: "content", text: "  " },
        ],
        [pm.id]: [{ kind: "content", text: "PM answer." }],
      },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);

    const events = await collect(new Debate(engine, [cto, pm], FREEFORM_1R).run("topic"));

    // CTO retried once, then gave up.
    expect(engine.sendCount(cto.id)).toBe(2);

    // The empty-after-retry turn is surfaced as an error (not silently dropped),
    // and NOT persisted as a blank turn.end.
    const errors = only(events, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.expertSlug).toBe("cto");
    expect(errors[0]?.message).toMatch(/empty/i);
    expect(errors[0]?.message).toMatch(/retr/i);
    expect(errors[0]?.recoverable).toBe(false);

    const ctoTurnEnds = only(events, "turn.end").filter((e) => e.expertSlug === "cto");
    expect(ctoTurnEnds).toHaveLength(0);

    // The other expert's result is preserved and the debate completes.
    const pmTurnEnds = only(events, "turn.end").filter((e) => e.expertSlug === "pm");
    expect(pmTurnEnds).toHaveLength(1);
    expect(pmTurnEnds[0]?.content).toBe("PM answer.");

    const end = only(events, "debate.end");
    expect(end).toHaveLength(1);
    expect(end[0]?.reason).toBe("completed");
  });

  it("does not retry or emit a retry event for a non-empty response", async () => {
    const engine = new ScriptedEngine({
      scripts: { [cto.id]: [{ kind: "content", text: "Single clean answer." }] },
    });
    await engine.start();
    await engine.addExpert(cto);

    const events = await collect(new Debate(engine, [cto], FREEFORM_1R).run("topic"));

    expect(engine.sendCount(cto.id)).toBe(1);
    expect(only(events, "turn.retry")).toHaveLength(0);
    const turnEnds = only(events, "turn.end");
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.content).toBe("Single clean answer.");
  });
});
