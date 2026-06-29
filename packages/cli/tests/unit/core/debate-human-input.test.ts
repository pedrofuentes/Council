/**
 * Tests for HumanInputProvider error/empty handling in `Debate` (#208, #206).
 *
 *   - #208: a throw from `getInput()` must NOT propagate unguarded — the
 *     orchestrator emits a structured `error` event + a `cost.update`
 *     (parity with the AI-turn failure path) and continues the debate.
 *   - #206: submitted content is trimmed; whitespace-only submissions are
 *     treated as cancelled (no `turn.end`), and surrounding whitespace is
 *     stripped before persistence.
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

async function collect(iter: AsyncIterable<DebateEvent>): Promise<DebateEvent[]> {
  const events: DebateEvent[] = [];
  for await (const e of iter) events.push(e);
  return events;
}

describe("Debate human input — error parity (#208)", () => {
  it("getInput() throwing emits a non-recoverable error + cost.update, no turn.end", async () => {
    const engine = new MockEngine();
    const human = makeExpert("lead", { model: "human" });

    const humanInput: HumanInputProvider = {
      async getInput() {
        throw new Error("stdin exploded");
      },
    };

    const debate = new Debate(engine, [human], baseConfig, {
      humanSlugs: new Set(["lead"]),
      humanInput,
    });

    const events = await collect(debate.run("Topic?"));

    const errors = events.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as { recoverable: boolean }).recoverable).toBe(false);
    expect((errors[0] as { message: string }).message).toMatch(/stdin exploded/);
    // cost.update still emitted so the run accounting closes out
    expect(events.some((e) => e.kind === "cost.update")).toBe(true);
    // no turn.end persisted for the failed human turn
    expect(events.filter((e) => e.kind === "turn.end")).toHaveLength(0);
    // debate completes (a human error is non-terminal)
    const end = events.find((e) => e.kind === "debate.end");
    expect(end && end.kind === "debate.end" ? end.reason : "").toBe("completed");
  });
});

describe("Debate human input — whitespace validation (#206)", () => {
  it("whitespace-only submission is treated as cancelled (no turn.end)", async () => {
    const engine = new MockEngine();
    const human = makeExpert("lead", { model: "human" });

    const humanInput: HumanInputProvider = {
      async getInput() {
        return { kind: "submitted", content: "   \n\t  " };
      },
    };

    const debate = new Debate(engine, [human], baseConfig, {
      humanSlugs: new Set(["lead"]),
      humanInput,
    });

    const events = await collect(debate.run("Topic?"));

    expect(events.filter((e) => e.kind === "turn.end")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "error")).toHaveLength(1);
  });

  it("trims surrounding whitespace from a valid submission before persisting", async () => {
    const engine = new MockEngine();
    const human = makeExpert("lead", { model: "human" });

    const humanInput: HumanInputProvider = {
      async getInput() {
        return { kind: "submitted", content: "  ship the MVP  " };
      },
    };

    const debate = new Debate(engine, [human], baseConfig, {
      humanSlugs: new Set(["lead"]),
      humanInput,
    });

    const events = await collect(debate.run("Topic?"));
    const turnEnd = events.find((e) => e.kind === "turn.end");
    expect(turnEnd).toBeDefined();
    if (turnEnd?.kind === "turn.end") {
      expect(turnEnd.content).toBe("ship the MVP");
    }
  });
});
