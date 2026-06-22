/**
 * Tests for `Debate` soft word-budget injection.
 *
 * `maxWordsPerResponse` was fully plumbed (CLI `--max-words` → `DebateConfig`)
 * but never reached the model. These tests prove the budget is now appended to
 * every AI expert turn — in BOTH structured and freeform modes — at the single
 * `#runAiTurn` chokepoint, that it names the configured value, that the `0`
 * sentinel (used by `chat`) leaves prompts uncapped, and that the budget lands
 * AFTER the `[REFERENCE DOCUMENTS]` block so it remains the final instruction.
 */
import { describe, expect, it } from "vitest";

import type { ExpertSpec } from "../../../src/engine/index.js";
import { MockEngine } from "../../../src/engine/mock/mock-engine.js";

import { Debate, type DebateConfig } from "../../../src/core/debate.js";
import type { DebateEvent } from "../../../src/core/types.js";
import type { DocumentSnippet } from "../../../src/core/documents/retriever.js";

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

const REFERENCE_DOCS: readonly DocumentSnippet[] = [
  {
    source: "finance.xlsx",
    sourcePath: "/docs/panels/board/finance.xlsx",
    content: "Q3 MRR is 73471 dollars across all active plans.",
    relevanceScore: 1,
  },
];

describe("Debate — soft word-budget injection (maxWordsPerResponse)", () => {
  it("appends the word budget to every AI prompt in structured mode", async () => {
    const experts = [expert("alpha"), expert("beta")];
    const engine = await makeEngine(experts);

    const config: DebateConfig = {
      maxRounds: 1,
      maxWordsPerResponse: 250,
      mode: "structured",
      retryBackoffMs: [1, 2],
    };
    const debate = new Debate(engine, experts, config);
    await collect(debate.run("Should we ship?"));

    expect(engine.sentPrompts.length).toBeGreaterThan(0);
    for (const p of engine.sentPrompts) {
      expect(p.prompt).toContain("aim for about 250 words");
    }
  });

  it("appends the word budget in freeform mode (round-robin)", async () => {
    const experts = [expert("alpha")];
    const engine = await makeEngine(experts);

    const config: DebateConfig = {
      maxRounds: 1,
      maxWordsPerResponse: 250,
      mode: "freeform",
      retryBackoffMs: [1, 2],
    };
    const debate = new Debate(engine, experts, config);
    await collect(debate.run("Should we ship?"));

    expect(engine.sentPrompts.length).toBeGreaterThan(0);
    for (const p of engine.sentPrompts) {
      expect(p.prompt).toContain("aim for about 250 words");
    }
  });

  it("leaves prompts uncapped when maxWordsPerResponse is 0 (chat sentinel)", async () => {
    const experts = [expert("alpha")];
    const engine = await makeEngine(experts);

    const config: DebateConfig = {
      maxRounds: 1,
      maxWordsPerResponse: 0,
      mode: "structured",
      retryBackoffMs: [1, 2],
    };
    const debate = new Debate(engine, experts, config);
    await collect(debate.run("Should we ship?"));

    expect(engine.sentPrompts.length).toBeGreaterThan(0);
    for (const p of engine.sentPrompts) {
      expect(p.prompt).not.toContain("aim for about");
    }
  });

  it("appends the budget AFTER the [REFERENCE DOCUMENTS] block", async () => {
    const experts = [expert("alpha")];
    const engine = await makeEngine(experts);

    const config: DebateConfig = {
      maxRounds: 1,
      maxWordsPerResponse: 250,
      mode: "freeform",
      retryBackoffMs: [1, 2],
      referenceDocuments: REFERENCE_DOCS,
    };
    const debate = new Debate(engine, experts, config);
    await collect(debate.run("What is our MRR?"));

    expect(engine.sentPrompts.length).toBeGreaterThan(0);
    for (const p of engine.sentPrompts) {
      const refIdx = p.prompt.indexOf("[REFERENCE DOCUMENTS]");
      const budgetIdx = p.prompt.indexOf("aim for about");
      expect(refIdx).toBeGreaterThanOrEqual(0);
      expect(budgetIdx).toBeGreaterThan(refIdx);
    }
  });
});
