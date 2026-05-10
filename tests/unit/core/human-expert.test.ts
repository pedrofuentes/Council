/**
 * Tests for human-as-expert participation in debates (ROADMAP §3.3).
 *
 * RED at this commit: HumanInputProvider does not exist, Debate does
 * not accept humanSlugs, convene does not accept --human.
 */
import { describe, expect, it } from "vitest";

import { Debate, type DebateConfig } from "../../../src/core/debate.js";
import type { HumanInputProvider } from "../../../src/core/human-input.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";
import type { ExpertSpec } from "../../../src/engine/index.js";
import type { DebateEvent } from "../../../src/core/types.js";

function makeExpert(slug: string, overrides: Partial<ExpertSpec> = {}): ExpertSpec {
  return {
    id: `id-${slug}`,
    slug,
    displayName: slug.toUpperCase(),
    model: "test-model",
    systemMessage: `You are ${slug}.`,
    ...overrides,
  };
}

const baseConfig: DebateConfig = {
  maxRounds: 1,
  maxWordsPerResponse: 50,
  mode: "freeform",
};

async function collectEvents(iter: AsyncIterable<DebateEvent>): Promise<DebateEvent[]> {
  const events: DebateEvent[] = [];
  for await (const e of iter) events.push(e);
  return events;
}

describe("Human-as-expert participation", () => {
  it("Debate accepts humanSlugs and routes human turns through HumanInputProvider instead of engine", async () => {
    const engine = new MockEngine();
    const aiExpert = makeExpert("cto");
    const humanExpert = makeExpert("product-lead", { model: "human" });

    await engine.start();
    await engine.addExpert(aiExpert);

    const humanInput: HumanInputProvider = {
      async getInput() {
        return { kind: "submitted", content: "I think we should ship the MVP." };
      },
    };

    const debate = new Debate(engine, [aiExpert, humanExpert], baseConfig, {
      humanSlugs: new Set(["product-lead"]),
      humanInput,
    });

    const events = await collectEvents(debate.run("Should we ship?"));

    // Should have turn events for both experts
    const turnEnds = events.filter((e) => e.kind === "turn.end");
    expect(turnEnds).toHaveLength(2);

    // Human turn should have speakerKind "human"
    const humanTurn = turnEnds.find(
      (e) => e.kind === "turn.end" && e.expertSlug === "product-lead",
    );
    expect(humanTurn).toBeDefined();
    if (humanTurn?.kind === "turn.end") {
      expect(humanTurn.content).toBe("I think we should ship the MVP.");
      expect(humanTurn.speakerKind).toBe("human");
    }

    // AI turn should have speakerKind "expert" (or undefined for backwards compat)
    const aiTurn = turnEnds.find(
      (e) => e.kind === "turn.end" && e.expertSlug === "cto",
    );
    expect(aiTurn).toBeDefined();
    if (aiTurn?.kind === "turn.end") {
      expect(aiTurn.speakerKind).toBe("expert");
    }
  });

  it("human turns do NOT count as premium requests in cost.update", async () => {
    const engine = new MockEngine();
    const aiExpert = makeExpert("cto");
    const humanExpert = makeExpert("product-lead", { model: "human" });

    await engine.start();
    await engine.addExpert(aiExpert);

    const humanInput: HumanInputProvider = {
      async getInput() {
        return { kind: "submitted", content: "Ship it." };
      },
    };

    const debate = new Debate(engine, [aiExpert, humanExpert], baseConfig, {
      humanSlugs: new Set(["product-lead"]),
      humanInput,
    });

    const events = await collectEvents(debate.run("Should we ship?"));
    const costUpdates = events.filter((e) => e.kind === "cost.update");

    // Only 1 AI expert → only 1 premium request
    const lastCost = costUpdates[costUpdates.length - 1];
    expect(lastCost).toBeDefined();
    if (lastCost?.kind === "cost.update") {
      expect(lastCost.premiumRequests).toBe(1);
    }
  });

  it("human turn.start has speakerKind 'human'", async () => {
    const engine = new MockEngine();
    const humanExpert = makeExpert("lead", { model: "human" });

    const humanInput: HumanInputProvider = {
      async getInput() {
        return { kind: "submitted", content: "My input." };
      },
    };

    const debate = new Debate(engine, [humanExpert], baseConfig, {
      humanSlugs: new Set(["lead"]),
      humanInput,
    });

    const events = await collectEvents(debate.run("Topic?"));
    const turnStarts = events.filter((e) => e.kind === "turn.start");
    expect(turnStarts).toHaveLength(1);
    if (turnStarts[0]?.kind === "turn.start") {
      expect(turnStarts[0].speakerKind).toBe("human");
    }
  });

  it("cancelled human input emits error event and skips turn", async () => {
    const engine = new MockEngine();
    const humanExpert = makeExpert("lead", { model: "human" });

    const humanInput: HumanInputProvider = {
      async getInput() {
        return { kind: "cancelled", reason: "EOF" };
      },
    };

    const debate = new Debate(engine, [humanExpert], baseConfig, {
      humanSlugs: new Set(["lead"]),
      humanInput,
    });

    const events = await collectEvents(debate.run("Topic?"));
    // Should have an error event for the cancelled turn
    const errors = events.filter((e) => e.kind === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    // Should NOT have a turn.end for the cancelled expert
    const turnEnds = events.filter((e) => e.kind === "turn.end");
    expect(turnEnds).toHaveLength(0);
  });

  it("human experts are not sent to engine.send()", async () => {
    const engine = new MockEngine();
    const aiExpert = makeExpert("cto");
    const humanExpert = makeExpert("lead", { model: "human" });

    await engine.start();
    await engine.addExpert(aiExpert);

    const humanInput: HumanInputProvider = {
      async getInput() {
        return { kind: "submitted", content: "Human says hello." };
      },
    };

    const debate = new Debate(engine, [aiExpert, humanExpert], baseConfig, {
      humanSlugs: new Set(["lead"]),
      humanInput,
    });

    await collectEvents(debate.run("Topic?"));

    // MockEngine tracks sent prompts — only AI expert should appear
    expect(engine.sentPrompts).toHaveLength(1);
    expect(engine.sentPrompts[0]?.expertId).toBe("id-cto");
  });
});
