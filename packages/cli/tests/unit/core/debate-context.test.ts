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
 *   5. (#2014) The configured `summarizer.maxSummaryLength` is threaded
 *      end-to-end into `ModeratorContext.maxSummaryLength` by
 *      `Debate.buildCtx`, including values ABOVE `sanitizeFenced`'s
 *      hardcoded 4000-char default (#635) — the case where a dropped
 *      threading regression would otherwise go undetected.
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
        summarizer: { summarizeAfterRound: 2, maxSummaryLength: 500, mode: "heuristic" },
      },
    };

    await collect(new Debate(engine, experts, config).run("Topic"));

    // With per-turn re-plan under contextConfig, planRound is called
    // once per expert per round. Indices: [r0_a, r0_b, r1_a, r1_b,
    // r2_a, r2_b, ...]. Rounds 0 and 1 are below the threshold so no
    // summary should be attached on either expert's plan.
    expect(captured[0]?.rollingSummary ?? "").toBe("");
    expect(captured[1]?.rollingSummary ?? "").toBe("");
    expect(captured[2]?.rollingSummary ?? "").toBe("");
    expect(captured[3]?.rollingSummary ?? "").toBe("");

    // Round 2+ plans see a non-empty summary.
    expect(captured[4]?.rollingSummary ?? "").not.toBe("");
    expect(captured[5]?.rollingSummary ?? "").not.toBe("");
    expect(captured[4]?.rollingSummary ?? "").toContain("A");
    expect(captured[4]?.rollingSummary ?? "").toContain("B");
  });

  it("threads a configured maxSummaryLength >4000 into ModeratorContext (#2014)", async () => {
    // Regression test for #2014 (Sentinel 🟡 on PR #2009/#635): the 6
    // strategy-layer tests in moderator-strategy.test.ts construct
    // `ModeratorContext` BY HAND and set `ctx.maxSummaryLength` manually,
    // so they never exercise `Debate.buildCtx` at debate.ts:357-359,
    // which is the ONLY place that threads the configured
    // `SummarizerConfig.maxSummaryLength` from `contextConfig.summarizer`
    // into the context handed to a moderator strategy. The other debate
    // tests that DO exercise buildCtx (this file's "injects a rolling
    // summary" test above, and debate-abort.test.ts) only use caps below
    // sanitizeFenced's hardcoded 4000-char default, where "threaded
    // correctly" and "silently dropped and fell back to the default" are
    // indistinguishable. A cap ABOVE 4000 is required to discriminate:
    // if `maxSummaryLength: summarizer.maxSummaryLength` were ever
    // dropped from the object spread, `ctx.maxSummaryLength` would be
    // `undefined` here instead of the configured 6000, and this
    // assertion would fail.
    const experts = [expert("a"), expert("b")];
    const engine = await makeEngine(
      { "id-a": "A position statement.", "id-b": "B position statement." },
      experts,
    );

    const captured: ModeratorContext[] = [];
    const strategy = recordingStrategy(captured);
    const configuredMaxSummaryLength = 6000; // > sanitizeFenced's 4000 default (#635).

    const config: DebateConfig = {
      maxRounds: 3,
      maxWordsPerResponse: 50,
      mode: "freeform",
      strategy,
      contextConfig: {
        summarizer: {
          summarizeAfterRound: 1,
          maxSummaryLength: configuredMaxSummaryLength,
          mode: "heuristic",
        },
      },
    };

    await collect(new Debate(engine, experts, config).run("Topic"));

    // Per-turn re-plan ordering: [r0_a, r0_b, r1_a, r1_b, r2_a, r2_b].
    // Round 0 is below summarizeAfterRound(1) — no summary is attached,
    // so debate.ts's `rollingSummary !== "" && summarizer` gate must
    // omit maxSummaryLength entirely (mirrors the "no contextConfig"
    // and "below threshold" assertions elsewhere in this file).
    expect(captured[0]?.rollingSummary ?? "").toBe("");
    expect(captured[1]?.rollingSummary ?? "").toBe("");
    expect(captured[0]?.maxSummaryLength).toBeUndefined();
    expect(captured[1]?.maxSummaryLength).toBeUndefined();

    // Round 1+ has a non-empty rolling summary, so buildCtx must thread
    // the CONFIGURED cap — the discriminating assertion for #2014.
    expect(captured[2]?.rollingSummary ?? "").not.toBe("");
    expect(captured[3]?.rollingSummary ?? "").not.toBe("");
    expect(captured[4]?.rollingSummary ?? "").not.toBe("");
    expect(captured[5]?.rollingSummary ?? "").not.toBe("");
    expect(captured[2]?.maxSummaryLength).toBe(configuredMaxSummaryLength);
    expect(captured[3]?.maxSummaryLength).toBe(configuredMaxSummaryLength);
    expect(captured[4]?.maxSummaryLength).toBe(configuredMaxSummaryLength);
    expect(captured[5]?.maxSummaryLength).toBe(configuredMaxSummaryLength);
  });

  it("'same-round' visibility lets later experts see earlier intra-round turns", async () => {
    const experts = [expert("a"), expert("b")];
    const engine = await makeEngine(
      { "id-a": "A reply.", "id-b": "B reply." },
      experts,
    );

    const captured: ModeratorContext[] = [];
    const strategy = recordingStrategy(captured);

    const config: DebateConfig = {
      maxRounds: 2,
      maxWordsPerResponse: 50,
      mode: "freeform",
      strategy,
      contextConfig: {
        visibility: { scope: "same-round" },
      },
    };

    await collect(new Debate(engine, experts, config).run("Topic"));

    // Per-turn re-plan ordering: [r0_a, r0_b, r1_a, r1_b].
    // Expert A speaks first in each round → no same-round priors yet.
    // Expert B speaks second → sees A's just-completed turn from the
    // current round (and ONLY that turn — earlier-round turns are
    // filtered out by the same-round scope).
    expect(captured).toHaveLength(4);
    expect(captured[0]?.priorTurns).toHaveLength(0);
    expect(captured[1]?.priorTurns).toHaveLength(1);
    expect(captured[1]?.priorTurns[0]?.expertSlug).toBe("a");
    expect(captured[1]?.priorTurns[0]?.round).toBe(0);

    expect(captured[2]?.priorTurns).toHaveLength(0);
    expect(captured[3]?.priorTurns).toHaveLength(1);
    expect(captured[3]?.priorTurns[0]?.expertSlug).toBe("a");
    expect(captured[3]?.priorTurns[0]?.round).toBe(1);
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

    // Final plan: prior turns total content should be under the cap.
    const finalCtx = captured.at(-1);
    expect(finalCtx).toBeDefined();
    if (finalCtx) {
      const totalChars = finalCtx.priorTurns.reduce(
        (acc, t) => acc + t.content.length,
        0,
      );
      expect(totalChars).toBeLessThanOrEqual(3000);

      // Truncation must drop oldest turns first. Each turn is 2000
      // chars, cap is 3000, so only the most recent turn fits and
      // older turns must be evicted.
      expect(finalCtx.priorTurns.length).toBe(1);

      // The surviving turn must be the most recent one (highest round
      // / last to be pushed), proving newest-wins eviction order.
      const surviving = finalCtx.priorTurns[finalCtx.priorTurns.length - 1];
      expect(surviving).toBeDefined();
      const maxRound = Math.max(
        ...captured.flatMap((c) => c.priorTurns.map((t) => t.round)),
      );
      expect(surviving?.round).toBe(maxRound);

      // And the oldest turn (round 0) must have been dropped.
      expect(finalCtx.priorTurns.some((t) => t.round === 0)).toBe(false);
    }
  });

  it("no contextConfig disables truncation entirely (legacy passthrough)", async () => {
    // Without contextConfig, even very large transcripts must be
    // forwarded verbatim — no implicit cap, no implicit filter.
    const experts = [expert("a"), expert("b")];
    const longResponse = "Y".repeat(60_000); // > the old 50k default cap
    const engine = await makeEngine(
      { "id-a": longResponse, "id-b": longResponse },
      experts,
    );

    const captured: ModeratorContext[] = [];
    const strategy = recordingStrategy(captured);

    const config: DebateConfig = {
      maxRounds: 3,
      maxWordsPerResponse: 50,
      mode: "freeform",
      strategy,
      // contextConfig: undefined  →  legacy behaviour
    };

    await collect(new Debate(engine, experts, config).run("Topic"));

    // Last plan sees ALL prior turns (2 experts × 2 completed rounds = 4),
    // none dropped despite total content >> 50_000 chars.
    expect(captured.at(-1)?.priorTurns).toHaveLength(4);
    const totalChars = captured
      .at(-1)
      ?.priorTurns.reduce((acc, t) => acc + t.content.length, 0);
    expect(totalChars).toBe(4 * 60_000);
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
