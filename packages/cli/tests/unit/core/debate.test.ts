/**
 * Tests for the debate orchestrator.
 *
 * Covers (per ROADMAP §1.8):
 *   - DebateEvent union shape (compile-time discrimination)
 *   - Debate.run() yields the correct event sequence:
 *     panel.assembled → round.start → turn.start → turn.delta* → turn.end → round.end → debate.end
 *   - Sequential turn order (no interleaving across experts within a round)
 *   - turn.end content matches accumulated turn.delta text
 *   - Stops at maxRounds (debate.end fires with reason 'completed')
 *   - cost.update events fire after each turn
 *   - error events surface engine errors (e.g., RATE_LIMITED)
 *
 * All tests use MockEngine — no real SDK, no real network.
 *
 * RED at this commit: src/core/debate.ts and src/core/types.ts do not exist.
 */
import { describe, expect, it } from "vitest";

import type { ExpertSpec } from "../../../src/engine/index.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";

import { Debate, type DebateConfig } from "../../../src/core/debate.js";
import type { DebateEvent } from "../../../src/core/types.js";

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

const FREEFORM_2R: DebateConfig = {
  maxRounds: 2,
  maxWordsPerResponse: 50,
  mode: "freeform",
};

async function collect(stream: AsyncIterable<DebateEvent>): Promise<DebateEvent[]> {
  const out: DebateEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

describe("Debate.run() — basic event sequence", () => {
  it("yields panel.assembled first", async () => {
    const engine = new MockEngine({
      responses: { "01HZ-cto": "CTO opening.", "01HZ-pm": "PM opening." },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);
    const debate = new Debate(engine, [cto, pm], FREEFORM_2R);
    const events = await collect(debate.run("Should we adopt microservices?"));
    expect(events[0]?.kind).toBe("panel.assembled");
    if (events[0]?.kind === "panel.assembled") {
      expect(events[0].experts.map((e) => e.slug)).toEqual(["cto", "pm"]);
    }
  });

  it("yields events in correct order per round", async () => {
    const engine = new MockEngine({
      responses: { "01HZ-cto": "C1.", "01HZ-pm": "P1." },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);
    const debate = new Debate(engine, [cto, pm], { ...FREEFORM_2R, maxRounds: 1 });
    const events = await collect(debate.run("topic"));

    // Strip cost events for the structural sequence check
    const seq = events.filter((e) => e.kind !== "cost.update").map((e) => e.kind);
    expect(seq[0]).toBe("panel.assembled");
    expect(seq[1]).toBe("round.start");
    // For 2 experts: turn.start, deltas..., turn.end, then turn.start, deltas..., turn.end
    expect(seq).toContain("turn.start");
    expect(seq).toContain("turn.end");
    expect(seq[seq.length - 2]).toBe("round.end");
    expect(seq[seq.length - 1]).toBe("debate.end");
  });

  it("debate.end uses reason 'completed' when maxRounds reached", async () => {
    const engine = new MockEngine({
      responses: { "01HZ-cto": "ok." },
    });
    await engine.start();
    await engine.addExpert(cto);
    const debate = new Debate(engine, [cto], { ...FREEFORM_2R, maxRounds: 1 });
    const events = await collect(debate.run("topic"));
    const last = events[events.length - 1];
    expect(last?.kind).toBe("debate.end");
    if (last?.kind === "debate.end") expect(last.reason).toBe("completed");
  });
});

describe("Debate.run() — turn ordering and delta accumulation", () => {
  it("each turn.end content equals the concatenation of its turn.delta text", async () => {
    const engine = new MockEngine({
      responses: {
        "01HZ-cto": "First sentence. Second sentence.",
        "01HZ-pm": "Only one.",
      },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);
    const debate = new Debate(engine, [cto, pm], { ...FREEFORM_2R, maxRounds: 1 });
    const events = await collect(debate.run("topic"));

    // Group deltas by expertSlug → string
    const accumulated = new Map<string, string>();
    for (const evt of events) {
      if (evt.kind === "turn.delta") {
        accumulated.set(evt.expertSlug, (accumulated.get(evt.expertSlug) ?? "") + evt.text);
      }
    }
    // Compare each turn.end content to accumulated string
    for (const evt of events) {
      if (evt.kind === "turn.end") {
        expect(evt.content).toBe(accumulated.get(evt.expertSlug));
      }
    }
  });

  it("experts speak sequentially within a round (no interleaving)", async () => {
    // Multi-sentence responses produce 3+ deltas per expert; combined with a
    // generous deltaDelayMs they open a real interleaving window that would
    // expose any parallel execution in the orchestrator (CI-flake guard).
    const engine = new MockEngine({
      responses: {
        "01HZ-cto": "C-first. C-second. C-third.",
        "01HZ-pm": "P-first. P-second. P-third.",
      },
      deltaDelayMs: 25,
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);
    const debate = new Debate(engine, [cto, pm], { ...FREEFORM_2R, maxRounds: 1 });
    const events = await collect(debate.run("topic"));
    // For each expert, every delta+end must come AFTER all events for the previous expert
    // in the same round. Concretely: once we see a turn.start for pm, we should never
    // see a turn.* event for cto in that round.
    let currentSpeaker: string | null = null;
    for (const evt of events) {
      if (evt.kind === "turn.start") {
        currentSpeaker = evt.expertSlug;
      } else if (
        (evt.kind === "turn.delta" || evt.kind === "turn.end") &&
        currentSpeaker !== null
      ) {
        expect(evt.expertSlug).toBe(currentSpeaker);
      }
    }
  });

  it("emits cost.update after each turn with monotonic premiumRequests count", async () => {
    const engine = new MockEngine({
      responses: { "01HZ-cto": "ok.", "01HZ-pm": "ok." },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);
    const debate = new Debate(engine, [cto, pm], { ...FREEFORM_2R, maxRounds: 2 });
    const events = await collect(debate.run("topic"));
    const costs = events.filter(
      (e): e is Extract<DebateEvent, { kind: "cost.update" }> => e.kind === "cost.update",
    );
    expect(costs.length).toBeGreaterThanOrEqual(4); // 2 experts * 2 rounds
    // Monotonic non-decreasing
    for (let i = 1; i < costs.length; i++) {
      const prev = costs[i - 1];
      const curr = costs[i];
      if (prev && curr) {
        expect(curr.premiumRequests).toBeGreaterThanOrEqual(prev.premiumRequests);
      }
    }
  });
});

describe("Debate.run() — error path", () => {
  it("yields an error event when an expert send fails, then continues to debate.end", async () => {
    const engine = new MockEngine({
      responses: { "01HZ-cto": "ok.", "01HZ-pm": "should not get here in failing turn" },
      failures: { "01HZ-pm": { code: "RATE_LIMITED", message: "Quota exhausted" } },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);
    // retryBackoffMs: [1, 2] keeps the test fast; default [250, 1000] adds ~1.26s
    const debate = new Debate(engine, [cto, pm], {
      ...FREEFORM_2R,
      maxRounds: 1,
      retryBackoffMs: [1, 2],
    });
    const events = await collect(debate.run("topic"));
    const errors = events.filter((e) => e.kind === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    // Error payload shape: expertSlug pinned to the failing expert; recoverable
    // reflects isRecoverable(RATE_LIMITED) === true from the engine contract.
    const firstError = errors[0];
    expect(firstError?.kind).toBe("error");
    if (firstError?.kind === "error") {
      expect(firstError.expertSlug).toBe("pm");
      expect(firstError.recoverable).toBe(true);
    }
    // A failed turn must NOT emit turn.end — it would persist an empty row.
    const pmTurnEnds = events.filter((e) => e.kind === "turn.end" && e.expertSlug === "pm");
    expect(pmTurnEnds).toHaveLength(0);
    // The debate continues past the error and closes normally.
    const last = events[events.length - 1];
    expect(last?.kind).toBe("debate.end");
  });
});

describe("Debate.run() — edge cases", () => {
  it("emits panel.assembled then throws when experts is empty (round-robin guard)", async () => {
    const engine = new MockEngine({});
    await engine.start();
    const debate = new Debate(engine, [], { ...FREEFORM_2R, maxRounds: 1 });
    const collected: DebateEvent[] = [];
    // The round-robin strategy calls assertNonEmptyExperts() inside planRound(),
    // which fires AFTER round.start. The throw propagates through the generator.
    await expect(async () => {
      for await (const evt of debate.run("topic")) {
        collected.push(evt);
      }
    }).rejects.toThrow(/round-robin.*requires at least one expert/);
    // panel.assembled is always the first event, even for an empty panel.
    expect(collected[0]?.kind).toBe("panel.assembled");
    if (collected[0]?.kind === "panel.assembled") {
      expect(collected[0].experts).toHaveLength(0);
    }
    // round.start fires before planRound() — verify it was emitted.
    expect(collected[1]?.kind).toBe("round.start");
  });

  it("emits only panel.assembled and debate.end when maxRounds is 0", async () => {
    const engine = new MockEngine({ responses: { "01HZ-cto": "ok." } });
    await engine.start();
    await engine.addExpert(cto);
    const debate = new Debate(engine, [cto], { ...FREEFORM_2R, maxRounds: 0 });
    const events = await collect(debate.run("topic"));
    // The for-loop condition (round < 0) is immediately false — no rounds run.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["panel.assembled", "debate.end"]);
    const last = events[events.length - 1];
    if (last?.kind === "debate.end") {
      expect(last.reason).toBe("completed");
    }
  });
});
