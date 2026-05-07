/**
 * Tests for structured debate mode (ROADMAP §2.2).
 *
 * Structured mode runs a fixed 4-phase choreography regardless of
 * `maxRounds`:
 *
 *   1. opening          — each expert delivers an opening statement
 *   2. cross-examination — each expert is asked targeted questions about
 *                          the OTHER experts' opening statements
 *   3. rebuttal          — each expert rebuts the other experts' positions
 *   4. synthesis         — each expert delivers a final synthesized stance
 *
 * Phase ordering is strict: phase N+1 starts only after phase N has
 * completed for ALL experts. Within a phase, experts speak in panel
 * order (matches freeform within-round ordering).
 *
 * Cross-examination questions are deterministic in this PR — generated
 * from a template that quotes the other experts' opening content. An
 * LLM-driven moderator that generates targeted questions ships in
 * ROADMAP §2.3 (Pluggable Moderator Strategies).
 *
 * RED at this commit: src/core/debate.ts ignores `mode: "structured"`
 * and falls through to freeform behavior. Once the `phase` field is
 * threaded through `DebateEvent.round.start`, these tests will pass.
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
const designer: ExpertSpec = {
  id: "01HZ-designer",
  slug: "designer",
  displayName: "Designer",
  model: "claude-sonnet-4",
  systemMessage: "You are a Designer.",
};

const STRUCTURED: DebateConfig = {
  // maxRounds is intentionally != 4 to verify it is IGNORED in structured mode.
  maxRounds: 99,
  maxWordsPerResponse: 50,
  mode: "structured",
};

async function collect(stream: AsyncIterable<DebateEvent>): Promise<DebateEvent[]> {
  const out: DebateEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

async function buildEngine(seedResponses: Record<string, string>): Promise<MockEngine> {
  const engine = new MockEngine({ responses: seedResponses });
  await engine.start();
  await engine.addExpert(cto);
  await engine.addExpert(pm);
  return engine;
}

describe("Structured debate — phase choreography", () => {
  it("emits exactly 4 rounds with phases opening → cross-examination → rebuttal → synthesis", async () => {
    const engine = await buildEngine({
      "01HZ-cto": "CTO opening.",
      "01HZ-pm": "PM opening.",
    });
    const events = await collect(new Debate(engine, [cto, pm], STRUCTURED).run("topic"));

    const roundStarts = events.filter((e) => e.kind === "round.start");
    expect(roundStarts).toHaveLength(4);
    expect(roundStarts.map((r) => (r as { phase: string }).phase)).toEqual([
      "opening",
      "cross-examination",
      "rebuttal",
      "synthesis",
    ]);
  });

  it("ignores maxRounds in structured mode (always 4 phases)", async () => {
    const engine = await buildEngine({
      "01HZ-cto": "CTO.",
      "01HZ-pm": "PM.",
    });
    // STRUCTURED.maxRounds is 99 but only 4 rounds should fire.
    const events = await collect(new Debate(engine, [cto, pm], STRUCTURED).run("topic"));
    expect(events.filter((e) => e.kind === "round.start")).toHaveLength(4);
    expect(events.filter((e) => e.kind === "round.end")).toHaveLength(4);
  });

  it("completes every expert's turn within a phase before starting the next phase", async () => {
    const engine = await buildEngine({
      "01HZ-cto": "CTO opening.",
      "01HZ-pm": "PM opening.",
    });
    const events = await collect(new Debate(engine, [cto, pm], STRUCTURED).run("topic"));

    // Build a flat ordered list of (event_kind, round) and assert
    // that for every expert, all turn.end events appear in strictly
    // increasing round order with no overlap across phases.
    let currentRound = -1;
    let turnsThisRound = 0;
    for (const e of events) {
      if (e.kind === "round.start") {
        if (currentRound >= 0) {
          // Previous round must have one turn per expert (or 0 if cross-exam was skipped — not the case for 2 experts).
          expect(turnsThisRound).toBe(2);
        }
        currentRound = e.round;
        turnsThisRound = 0;
      }
      if (e.kind === "turn.end") {
        turnsThisRound += 1;
      }
    }
    expect(turnsThisRound).toBe(2);
  });

  it("emits debate.end with reason 'completed' after synthesis", async () => {
    const engine = await buildEngine({
      "01HZ-cto": "CTO.",
      "01HZ-pm": "PM.",
    });
    const events = await collect(new Debate(engine, [cto, pm], STRUCTURED).run("topic"));
    const last = events[events.length - 1];
    expect(last.kind).toBe("debate.end");
    expect((last as { reason: string }).reason).toBe("completed");
  });
});

describe("Structured debate — phase prompts", () => {
  it("opening phase sends the original user prompt", async () => {
    const engine = await buildEngine({
      "01HZ-cto": "CTO opening words.",
      "01HZ-pm": "PM opening words.",
    });
    await collect(new Debate(engine, [cto, pm], STRUCTURED).run("Should we ship MVP?"));

    // sentPrompts captures {expertId, prompt} in temporal order.
    // The first 2 sends (one per expert) are the opening phase.
    const opening = engine.sentPrompts.slice(0, 2);
    for (const sent of opening) {
      expect(sent.prompt).toContain("Should we ship MVP?");
    }
  });

  it("cross-examination prompt for an expert references the OTHER experts by displayName", async () => {
    const engine = await buildEngine({
      "01HZ-cto": "CTO says ship now.",
      "01HZ-pm": "PM says wait two weeks.",
    });
    await collect(new Debate(engine, [cto, pm], STRUCTURED).run("Should we ship?"));

    // Sends 2 and 3 are the cross-examination phase (one per expert).
    const crossExam = engine.sentPrompts.slice(2, 4);

    const ctoCross = crossExam.find((s) => s.expertId === cto.id);
    const pmCross = crossExam.find((s) => s.expertId === pm.id);
    expect(ctoCross).toBeDefined();
    expect(pmCross).toBeDefined();

    // Each expert's cross-exam prompt must mention the OTHER expert's
    // displayName and quote (or summarize) their opening content.
    expect(ctoCross?.prompt ?? "").toContain("PM");
    expect(ctoCross?.prompt ?? "").toContain("PM says wait two weeks.");
    expect(pmCross?.prompt ?? "").toContain("CTO");
    expect(pmCross?.prompt ?? "").toContain("CTO says ship now.");
  });

  it("rebuttal prompt includes the other experts' opening AND cross-exam content", async () => {
    const engine = await buildEngine({
      "01HZ-cto": "CTO position.",
      "01HZ-pm": "PM position.",
    });
    await collect(new Debate(engine, [cto, pm], STRUCTURED).run("Topic?"));

    // Sends 4 and 5 are the rebuttal phase.
    const rebuttal = engine.sentPrompts.slice(4, 6);
    const ctoRebuttal = rebuttal.find((s) => s.expertId === cto.id);
    expect(ctoRebuttal).toBeDefined();
    // Rebuttal must reference the other expert (PM) by name.
    expect(ctoRebuttal?.prompt ?? "").toContain("PM");
    // And explicitly use the word "rebut" or "rebuttal" to instruct the LLM.
    expect((ctoRebuttal?.prompt ?? "").toLowerCase()).toMatch(/rebut/);
  });

  it("synthesis prompt instructs the expert to deliver a final position", async () => {
    const engine = await buildEngine({
      "01HZ-cto": "CTO.",
      "01HZ-pm": "PM.",
    });
    await collect(new Debate(engine, [cto, pm], STRUCTURED).run("Topic?"));

    // Sends 6 and 7 are the synthesis phase.
    const synthesis = engine.sentPrompts.slice(6, 8);
    expect(synthesis).toHaveLength(2);
    for (const sent of synthesis) {
      expect(sent.prompt.toLowerCase()).toMatch(/synthes|final|conclude/);
    }
  });

  it("synthesis prompt includes the OTHER experts' rebuttal content", async () => {
    // Distinct, identifiable strings for each phase so we can assert that
    // rebuttal content survives all the way into the synthesis prompt.
    const engine = new MockEngine({
      responses: {
        "01HZ-cto": "CTO_TOKEN",
        "01HZ-pm": "PM_REBUTTAL_TOKEN",
      },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);

    await collect(new Debate(engine, [cto, pm], STRUCTURED).run("Topic?"));

    // Sends 6 and 7 are the synthesis phase. CTO's synthesis prompt must
    // contain PM's rebuttal content (and vice-versa). Without the fix,
    // synthesis receives `[]` for rebuttalTurns and the prompt has no
    // Rebuttal: section at all.
    const synthesis = engine.sentPrompts.slice(6, 8);
    const ctoSynth = synthesis.find((s) => s.expertId === cto.id);
    expect(ctoSynth).toBeDefined();
    // Marker that buildSynthesisPrompt emits per phase line.
    expect(ctoSynth?.prompt ?? "").toMatch(/Rebuttal/);
    // PM is the other expert; their rebuttal token must appear in CTO's
    // synthesis prompt under a `(Rebuttal)` line.
    expect(ctoSynth?.prompt ?? "").toContain("PM (Rebuttal)");
  });
});

describe("Structured debate — edge cases", () => {
  it("with a single expert, skips cross-examination phase (3 rounds: opening, rebuttal, synthesis)", async () => {
    const engine = new MockEngine({ responses: { "01HZ-cto": "Solo CTO." } });
    await engine.start();
    await engine.addExpert(cto);

    const events = await collect(new Debate(engine, [cto], STRUCTURED).run("topic"));
    const phases = events
      .filter((e) => e.kind === "round.start")
      .map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(["opening", "rebuttal", "synthesis"]);
    expect(phases).not.toContain("cross-examination");
  });

  it("with three experts, cross-exam prompt for each expert references both others", async () => {
    const engine = new MockEngine({
      responses: {
        "01HZ-cto": "CTO opens.",
        "01HZ-pm": "PM opens.",
        "01HZ-designer": "Designer opens.",
      },
    });
    await engine.start();
    await engine.addExpert(cto);
    await engine.addExpert(pm);
    await engine.addExpert(designer);

    await collect(new Debate(engine, [cto, pm, designer], STRUCTURED).run("Topic?"));

    // Sends 3, 4, 5 are the cross-examination phase (one per expert in panel order).
    const crossExam = engine.sentPrompts.slice(3, 6);
    const ctoCross = crossExam.find((s) => s.expertId === cto.id);
    expect(ctoCross).toBeDefined();
    expect(ctoCross?.prompt ?? "").toContain("PM");
    expect(ctoCross?.prompt ?? "").toContain("Designer");
  });
});

describe("Structured debate — freeform mode regression", () => {
  it("freeform mode still works unchanged", async () => {
    const engine = await buildEngine({
      "01HZ-cto": "CTO.",
      "01HZ-pm": "PM.",
    });
    const config: DebateConfig = {
      maxRounds: 2,
      maxWordsPerResponse: 50,
      mode: "freeform",
    };
    const events = await collect(new Debate(engine, [cto, pm], config).run("topic"));
    // Freeform: 2 rounds, no `phase` field on round.start
    const roundStarts = events.filter((e) => e.kind === "round.start");
    expect(roundStarts).toHaveLength(2);
    for (const r of roundStarts) {
      expect((r as { phase?: string }).phase).toBeUndefined();
    }
  });
});
