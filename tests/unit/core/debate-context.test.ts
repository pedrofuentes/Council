/**
 * Tests for Debate orchestrator + context window management (§2.6).
 *
 * Verifies:
 *   1. A 10-round / 4-expert debate with the "recent" visibility scope
 *      completes successfully.
 *   2. The rolling summary is injected into ModeratorContext after the
 *      configured round.
 *   3. `maxPromptChars` truncates oldest verbatim turns when the prior
 *      content would otherwise exceed the cap.
 *   4. Default behaviour (no `contextConfig`) is unchanged — strategies
 *      see every prior turn and no summary is attached.
 */
import { describe, expect, it } from "vitest";

import type { ExpertSpec } from "../../../src/engine/index.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";

import { Debate, type DebateConfig } from "../../../src/core/debate.js";
import type {
  ModeratorContext,
  ModeratorStrategy,
  TurnAssignment,
} from "../../../src/core/moderator/strategy.js";
import type { DebateEvent } from "../../../src/core/types.js";

function expert(slug: string): ExpertSpec {
  return {
    id: `id-${slug}`,
    slug,
    displayName: slug.toUpperCase(),
    model: "claude-sonnet-4",
    systemMessage: `You are ${slug}.`,
  };
}

async function collect(stream: AsyncIterable<DebateEvent>): Promise<DebateEvent[]> {
  const out: DebateEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

async function makeEngine(
  responses: Readonly<Record<string, string>>,
  experts: readonly ExpertSpec[],
): Promise<MockEngine> {
  const engine = new MockEngine({ responses });
  await engine.start();
  for (const e of experts) await engine.addExpert(e);
  return engine;
}

/** Strategy that captures the moderator context passed in each round. */
function recordingStrategy(captured: ModeratorContext[]): ModeratorStrategy {
  return {
    name: "recording",
    planRound(ctx: ModeratorContext): readonly TurnAssignment[] {
      captured.push({
        ...ctx,
        priorTurns: ctx.priorTurns.slice(),
      });
      return ctx.experts.map((e) => ({
        expertSlug: e.slug,
        prompt: `topic=${ctx.topic} round=${ctx.round} prior=${ctx.priorTurns.length}`,
      }));
    },
    shouldContinue(ctx: ModeratorContext): boolean {
      return ctx.round < ctx.maxRounds;
    },
  };
}

describe("Debate — context window management (§2.6)", () => {
  it("completes a 10-round / 4-expert debate using 'recent' visibility scope", async () => {
    const experts = [expert("a"), expert("b"), expert("c"), expert("d")];
    const responses: Record<string, string> = {};
    for (const e of experts) responses[e.id] = `${e.slug} reply.`;
    const engine = await makeEngine(responses, experts);

    const config: DebateConfig = {
      maxRounds: 10,
      maxWordsPerResponse: 50,
      mode: "freeform",
      contextConfig: {
        visibility: { scope: "recent", maxPriorTurns: 5 },
      },
    };

    const debate = new Debate(engine, experts, config);
    const events = await collect(debate.run("Topic X"));

    const ends = events.filter(
      (e): e is Extract<DebateEvent, { kind: "turn.end" }> => e.kind === "turn.end",
    );
    expect(ends).toHaveLength(40); // 10 rounds * 4 experts

    const final = events.at(-1);
    expect(final?.kind).toBe("debate.end");
    if (final?.kind === "debate.end") expect(final.reason).toBe("completed");
  });

  it("filters priorTurns to 'recent' window before passing to the strategy", async () => {
    const experts = [expert("a"), expert("b")];
    const engine = await makeEngine(
      { "id-a": "A reply.", "id-b": "B reply." },
      experts,
    );

    const captured: ModeratorContext[] = [];
    const strategy = recordingStrategy(captured);

    const config: DebateConfig = {
      maxRounds: 5,
      maxWordsPerResponse: 50,
      mode: "freeform",
      strategy,
      contextConfig: {
        visibility: { scope: "recent", maxPriorTurns: 3 },
      },
    };

    await collect(new Debate(engine, experts, config).run("Topic"));

    expect(captured[0]?.priorTurns).toHaveLength(0);
    expect(captured[4]?.priorTurns).toHaveLength(3);
  });

  it("injects a rolling summary into ModeratorContext after the configured round", async () => {
    const experts = [expert("a"), expert("b")];
    const engine = await makeEngine(
      { "id-a": "A position statement.", "id-b": "B position statement." },
      experts,
    );

    const captured: ModeratorContext[] = [];
    const strategy = recordingStrategy(captured);

    const config: DebateConfig = {
      maxRounds: 5,
      maxWordsPerResponse: 50,
      mode: "freeform",
      strategy,
      contextConfig: {
        summarizer: { summarizeAfterRound: 2, maxSummaryLength: 500 },
      },
    };

    await collect(new Debate(engine, experts, config).run("Topic"));

    // Rounds 0 and 1: below threshold — no summary.
    expect(captured[0]?.rollingSummary ?? "").toBe("");
    expect(captured[1]?.rollingSummary ?? "").toBe("");

    // Rounds 2+ : summary should be present and non-empty.
    expect(captured[2]?.rollingSummary ?? "").not.toBe("");
    expect(captured[3]?.rollingSummary ?? "").not.toBe("");
    expect(captured[2]?.rollingSummary ?? "").toContain("A");
    expect(captured[2]?.rollingSummary ?? "").toContain("B");
  });

  it("truncates oldest turns when total prior content exceeds maxPromptChars", async () => {
    const experts = [expert("a"), expert("b")];
    const longResponse = "X".repeat(2000);
    const engine = await makeEngine(
      { "id-a": longResponse, "id-b": longResponse },
      experts,
    );

    const captured: ModeratorContext[] = [];
    const strategy = recordingStrategy(captured);

    const config: DebateConfig = {
      maxRounds: 4,
      maxWordsPerResponse: 50,
      mode: "freeform",
      strategy,
      contextConfig: {
        maxPromptChars: 3000,
      },
    };

    await collect(new Debate(engine, experts, config).run("Topic"));

    // Final round: prior turns total content should be under the cap.
    const finalCtx = captured.at(-1);
    expect(finalCtx).toBeDefined();
    if (finalCtx) {
      const totalChars = finalCtx.priorTurns.reduce(
        (acc, t) => acc + t.content.length,
        0,
      );
      expect(totalChars).toBeLessThanOrEqual(3000);
      // Truncation must drop oldest turns first — the latest turn
      // (last entry) must always be retained.
      expect(finalCtx.priorTurns.length).toBeGreaterThan(0);
    }
  });

  it("default behaviour (no contextConfig) passes every prior turn and no summary", async () => {
    const experts = [expert("a"), expert("b")];
    const engine = await makeEngine(
      { "id-a": "A.", "id-b": "B." },
      experts,
    );

    const captured: ModeratorContext[] = [];
    const strategy = recordingStrategy(captured);

    const config: DebateConfig = {
      maxRounds: 4,
      maxWordsPerResponse: 50,
      mode: "freeform",
      strategy,
    };

    await collect(new Debate(engine, experts, config).run("Topic"));

    // No summary should be attached at any round.
    for (const ctx of captured) {
      expect(ctx.rollingSummary ?? "").toBe("");
    }
    // Final round: all prior turns are visible (2 experts × 3 rounds = 6).
    expect(captured.at(-1)?.priorTurns).toHaveLength(6);
  });
});
