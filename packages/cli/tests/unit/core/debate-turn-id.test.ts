/**
 * Tests for per-turn correlation: `turnId` must be plumbed through
 * `SendOptions` so the engine session can correlate streaming chunks back to
 * debate-level turns (#80). Previously the orchestrator generated a `turnId`
 * internally for `turn.end` only, and `engine.send()` received no identifier —
 * leaving per-turn correlation unplumbed.
 *
 * These tests prove the SAME id the orchestrator emits on `turn.end` is also
 * the one handed to `engine.send()` for that turn, in order.
 */
import { describe, expect, it } from "vitest";

import type { ExpertSpec } from "../../../src/engine/index.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";

import { Debate, type DebateConfig } from "../../../src/core/debate.js";
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

async function makeEngine(experts: readonly ExpertSpec[]): Promise<MockEngine> {
  const responses: Record<string, string> = {};
  for (const e of experts) responses[e.id] = `${e.slug} acknowledges.`;
  const engine = new MockEngine({ responses });
  await engine.start();
  for (const e of experts) await engine.addExpert(e);
  return engine;
}

describe("Debate — turnId plumbed through SendOptions (#80)", () => {
  it("hands a turnId to engine.send() matching the turn.end for each AI turn", async () => {
    const experts = [expert("alpha"), expert("beta")];
    const engine = await makeEngine(experts);

    const config: DebateConfig = { maxRounds: 1, mode: "freeform", retryBackoffMs: [1] };
    const debate = new Debate(engine, experts, config);
    const events = await collect(debate.run("Should we ship?"));

    const endTurnIds = events
      .filter((e): e is Extract<DebateEvent, { kind: "turn.end" }> => e.kind === "turn.end")
      .map((e) => e.turnId);
    const sentTurnIds = engine.sentPrompts.map((p) => p.turnId);

    expect(endTurnIds.length).toBe(2);
    // Every send must carry the SAME id later emitted on its turn.end.
    expect(sentTurnIds).toEqual(endTurnIds);
    for (const id of sentTurnIds) expect(id).toBeTruthy();
  });
});
