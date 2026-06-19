/**
 * Tests for ModeratorStrategy wiring into Debate orchestrator (#212).
 *
 * The strategies (`src/core/moderator/strategies.ts`) already exist as
 * pure functions. This suite verifies that `Debate.#runFreeform()`:
 *
 *   1. Defaults to round-robin when no strategy is given (event sequence
 *      identical to the previous hardcoded loop).
 *   2. Uses the strategy's `planRound()` for turn order.
 *   3. Sends the strategy's prompt (NOT the raw topic) to `engine.send()`.
 *   4. Honors `shouldContinue()` to end the debate early with
 *      `reason: "consensus"`.
 *   5. Continues to support human participants via HumanInputProvider.
 *
 * Structured mode (`mode: "structured"`) is unaffected — its phase-prompt
 * machinery is exercised by `tests/unit/core/structured-debate.test.ts`.
 */
import { describe, expect, it } from "vitest";

import type { ExpertSpec } from "../../../src/engine/index.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";

import { Debate, type DebateConfig } from "../../../src/core/debate.js";
import type { HumanInputProvider } from "../../../src/core/human-input.js";
import {
  createDevilsAdvocateStrategy,
  createRoundRobinStrategy,
} from "../../../src/core/moderator/strategies.js";
import type {
  ModeratorContext,
  ModeratorStrategy,
  TurnAssignment,
} from "../../../src/core/moderator/strategy.js";
import type { DebateEvent } from "../../../src/core/types.js";

const cto: ExpertSpec = {
  id: "id-cto",
  slug: "cto",
  displayName: "CTO",
  model: "claude-sonnet-4",
  systemMessage: "You are a CTO.",
};
const pm: ExpertSpec = {
  id: "id-pm",
  slug: "pm",
  displayName: "PM",
  model: "claude-sonnet-4",
  systemMessage: "You are a PM.",
};

const FREEFORM_1R: DebateConfig = {
  maxRounds: 1,
  maxWordsPerResponse: 50,
  mode: "freeform",
};
const FREEFORM_2R: DebateConfig = {
  ...FREEFORM_1R,
  maxRounds: 2,
};

async function collect(stream: AsyncIterable<DebateEvent>): Promise<DebateEvent[]> {
  const out: DebateEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

async function makeReadyEngine(
  responses: Readonly<Record<string, string>>,
  experts: readonly ExpertSpec[],
): Promise<MockEngine> {
  const engine = new MockEngine({ responses });
  await engine.start();
  for (const e of experts) await engine.addExpert(e);
  return engine;
}

describe("Debate freeform — default strategy (round-robin)", () => {
  it("preserves the structural event sequence when no strategy is given", async () => {
    const engine = await makeReadyEngine(
      { "id-cto": "C1.", "id-pm": "P1." },
      [cto, pm],
    );
    const debate = new Debate(engine, [cto, pm], FREEFORM_1R);
    const events = await collect(debate.run("topic"));

    const seq = events.filter((e) => e.kind !== "cost.update").map((e) => e.kind);
    expect(seq).toEqual([
      "panel.assembled",
      "round.start",
      "turn.start",
      "turn.delta",
      "turn.end",
      "turn.start",
      "turn.delta",
      "turn.end",
      "round.end",
      "debate.end",
    ]);

    const ends = events.filter(
      (e): e is Extract<DebateEvent, { kind: "turn.end" }> => e.kind === "turn.end",
    );
    expect(ends.map((e) => e.expertSlug)).toEqual(["cto", "pm"]);

    const finale = events.at(-1);
    expect(finale?.kind).toBe("debate.end");
    if (finale?.kind === "debate.end") expect(finale.reason).toBe("completed");
  });

  it("sends the strategy's prompt (not the raw topic) to engine.send()", async () => {
    const engine = await makeReadyEngine(
      { "id-cto": "C1.", "id-pm": "P1." },
      [cto, pm],
    );
    const debate = new Debate(engine, [cto, pm], FREEFORM_1R);
    await collect(debate.run("Should we ship?"));

    expect(engine.sentPrompts).toHaveLength(2);
    for (const sent of engine.sentPrompts) {
      expect(sent.prompt).toContain("Should we ship?");
      expect(sent.prompt).toContain("Deliver your position");
    }
  });
});

describe("Debate freeform — explicit round-robin strategy", () => {
  it("matches the default behavior", async () => {
    const engine = await makeReadyEngine(
      { "id-cto": "C1.", "id-pm": "P1." },
      [cto, pm],
    );
    const debate = new Debate(engine, [cto, pm], {
      ...FREEFORM_1R,
      strategy: createRoundRobinStrategy(),
    });
    const events = await collect(debate.run("topic"));

    const ends = events.filter(
      (e): e is Extract<DebateEvent, { kind: "turn.end" }> => e.kind === "turn.end",
    );
    expect(ends.map((e) => e.expertSlug)).toEqual(["cto", "pm"]);
  });

  it("includes prior turns in round 1 prompts", async () => {
    const engine = await makeReadyEngine(
      { "id-cto": "CTO position.", "id-pm": "PM position." },
      [cto, pm],
    );
    const debate = new Debate(engine, [cto, pm], {
      ...FREEFORM_2R,
      strategy: createRoundRobinStrategy(),
    });
    await collect(debate.run("topic"));

    expect(engine.sentPrompts).toHaveLength(4);
    const round1Prompts = engine.sentPrompts.slice(2, 4);
    for (const sent of round1Prompts) {
      expect(sent.prompt).toContain("Prior discussion");
      expect(sent.prompt).toContain("CTO position.");
      expect(sent.prompt).toContain("PM position.");
    }
  });
});

describe("Debate freeform — devils-advocate strategy", () => {
  it("gives the designated advocate a contrarian prompt", async () => {
    const engine = await makeReadyEngine(
      { "id-cto": "C1.", "id-pm": "P1." },
      [cto, pm],
    );
    const debate = new Debate(engine, [cto, pm], {
      ...FREEFORM_1R,
      strategy: createDevilsAdvocateStrategy("pm"),
    });
    await collect(debate.run("Topic"));

    const byExpert = new Map(engine.sentPrompts.map((p) => [p.expertId, p.prompt]));
    expect(byExpert.get("id-pm")).toContain("devil's advocate");
    expect(byExpert.get("id-cto") ?? "").not.toContain("devil's advocate");
  });
});

describe("Debate freeform — shouldContinue ends debate early", () => {
  it("emits debate.end with reason 'consensus' and stops further rounds", async () => {
    const engine = await makeReadyEngine(
      { "id-cto": "C.", "id-pm": "P." },
      [cto, pm],
    );

    const earlyExit: ModeratorStrategy = {
      name: "early-exit",
      planRound(ctx: ModeratorContext): readonly TurnAssignment[] {
        return ctx.experts.map((e) => ({
          expertSlug: e.slug,
          prompt: ctx.topic,
        }));
      },
      shouldContinue(ctx: ModeratorContext): boolean {
        return ctx.round === 0;
      },
    };

    const debate = new Debate(engine, [cto, pm], {
      ...FREEFORM_2R,
      maxRounds: 5,
      strategy: earlyExit,
    });
    const events = await collect(debate.run("Topic"));

    const roundStarts = events.filter((e) => e.kind === "round.start");
    expect(roundStarts).toHaveLength(1);

    const finale = events.at(-1);
    expect(finale?.kind).toBe("debate.end");
    if (finale?.kind === "debate.end") expect(finale.reason).toBe("consensus");
  });
});

describe("Debate freeform — strategy + human experts", () => {
  it("routes human turns through HumanInputProvider while AI turns hit the engine", async () => {
    const human: ExpertSpec = {
      id: "id-human",
      slug: "lead",
      displayName: "Lead",
      model: "human",
      systemMessage: "(human)",
    };
    const engine = await makeReadyEngine({ "id-cto": "C." }, [cto]);

    let humanCalls = 0;
    let lastHumanPrompt = "";
    const humanInput: HumanInputProvider = {
      async getInput(ctx) {
        humanCalls += 1;
        lastHumanPrompt = ctx.prompt;
        return { kind: "submitted", content: "Human reply." };
      },
    };

    const debate = new Debate(
      engine,
      [cto, human],
      { ...FREEFORM_1R, strategy: createRoundRobinStrategy() },
      { humanSlugs: new Set(["lead"]), humanInput },
    );
    const events = await collect(debate.run("Topic"));

    expect(humanCalls).toBe(1);
    expect(lastHumanPrompt).toContain("Topic");
    expect(lastHumanPrompt).toContain("Deliver your position");

    expect(engine.sentPrompts).toHaveLength(1);
    expect(engine.sentPrompts[0]?.expertId).toBe("id-cto");

    const ends = events.filter(
      (e): e is Extract<DebateEvent, { kind: "turn.end" }> => e.kind === "turn.end",
    );
    expect(ends.map((e) => e.expertSlug)).toEqual(["cto", "lead"]);
  });
});

describe("Debate freeform — strategy returns unknown slug", () => {
  it("emits a non-recoverable error and aborts the round (no turns run)", async () => {
    const engine = await makeReadyEngine(
      { "id-cto": "C.", "id-pm": "P." },
      [cto, pm],
    );

    const ghostStrategy: ModeratorStrategy = {
      name: "ghost-strategy",
      planRound(): readonly TurnAssignment[] {
        return [
          { expertSlug: "ghost", prompt: "missing expert" },
          { expertSlug: "cto", prompt: "real expert" },
        ];
      },
      shouldContinue(): boolean {
        return false;
      },
    };

    const debate = new Debate(engine, [cto, pm], {
      ...FREEFORM_1R,
      strategy: ghostStrategy,
    });
    const events = await collect(debate.run("Topic"));

    const errors = events.filter(
      (e): e is Extract<DebateEvent, { kind: "error" }> => e.kind === "error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.expertSlug).toBe("ghost");
    expect(errors[0]?.recoverable).toBe(false);
    expect(errors[0]?.message).toMatch(/ghost-strategy/);
    expect(errors[0]?.message).toMatch(/ghost/);

    // Round must abort cleanly: no turn.* events, but round.start and
    // round.end still bracket the failed round so consumers see a
    // well-formed structural sequence.
    const turnEvents = events.filter((e) => e.kind.startsWith("turn."));
    expect(turnEvents).toHaveLength(0);
    expect(engine.sentPrompts).toHaveLength(0);

    const roundStarts = events.filter((e) => e.kind === "round.start");
    const roundEnds = events.filter((e) => e.kind === "round.end");
    expect(roundStarts).toHaveLength(1);
    expect(roundEnds).toHaveLength(1);
  });

  it("emits a non-recoverable error when planRound returns duplicate slugs", async () => {
    const engine = await makeReadyEngine(
      { "id-cto": "C.", "id-pm": "P." },
      [cto, pm],
    );

    const dupStrategy: ModeratorStrategy = {
      name: "dup-strategy",
      planRound(): readonly TurnAssignment[] {
        return [
          { expertSlug: "cto", prompt: "first" },
          { expertSlug: "cto", prompt: "second" },
        ];
      },
      shouldContinue(): boolean {
        return false;
      },
    };

    const debate = new Debate(engine, [cto, pm], {
      ...FREEFORM_1R,
      strategy: dupStrategy,
    });
    const events = await collect(debate.run("Topic"));

    const errors = events.filter(
      (e): e is Extract<DebateEvent, { kind: "error" }> => e.kind === "error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/duplicate/i);
    expect(errors[0]?.message).toMatch(/cto/);
    expect(engine.sentPrompts).toHaveLength(0);
  });

  it("emits a non-recoverable error when planRound returns more assignments than experts", async () => {
    const engine = await makeReadyEngine({ "id-cto": "C." }, [cto]);

    const overStrategy: ModeratorStrategy = {
      name: "over-strategy",
      planRound(): readonly TurnAssignment[] {
        return [
          { expertSlug: "cto", prompt: "one" },
          { expertSlug: "cto", prompt: "two" },
        ];
      },
      shouldContinue(): boolean {
        return false;
      },
    };

    const debate = new Debate(engine, [cto], {
      ...FREEFORM_1R,
      strategy: overStrategy,
    });
    const events = await collect(debate.run("Topic"));

    const errors = events.filter(
      (e): e is Extract<DebateEvent, { kind: "error" }> => e.kind === "error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/1 expert/);
    expect(engine.sentPrompts).toHaveLength(0);
  });
});
