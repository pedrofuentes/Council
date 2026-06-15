/**
 * Tests for `Debate` reference-document injection (T1 RAG fix).
 *
 * Before this change `convene`/`Debate` never surfaced indexed panel or
 * expert documents to the experts — only the moderator-built topic prompt
 * reached the engine. These tests prove that when a debate is configured
 * with `referenceDocuments`, the shared `[REFERENCE DOCUMENTS]` block (the
 * exact formatter used by chat) is appended to every AI expert turn in
 * BOTH structured and freeform modes, so planted facts actually reach the
 * model.
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

async function makeEngine(
  experts: readonly ExpertSpec[],
): Promise<MockEngine> {
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

describe("Debate — referenceDocuments injection (T1 RAG fix)", () => {
  it("appends the [REFERENCE DOCUMENTS] block to every AI prompt in structured mode", async () => {
    const experts = [expert("alpha"), expert("beta")];
    const engine = await makeEngine(experts);

    const config: DebateConfig = {
      maxRounds: 1,
      maxWordsPerResponse: 0,
      mode: "structured",
      retryBackoffMs: [1, 2],
      referenceDocuments: REFERENCE_DOCS,
    };
    const debate = new Debate(engine, experts, config);
    await collect(debate.run("What is our MRR?"));

    expect(engine.sentPrompts.length).toBeGreaterThan(0);
    for (const p of engine.sentPrompts) {
      expect(p.prompt).toContain("[REFERENCE DOCUMENTS]");
      expect(p.prompt).toContain("73471");
      expect(p.prompt).toContain("finance.xlsx");
    }
  });

  it("also injects in freeform mode (round-robin)", async () => {
    const experts = [expert("alpha")];
    const engine = await makeEngine(experts);

    const config: DebateConfig = {
      maxRounds: 1,
      maxWordsPerResponse: 0,
      mode: "freeform",
      retryBackoffMs: [1, 2],
      referenceDocuments: REFERENCE_DOCS,
    };
    const debate = new Debate(engine, experts, config);
    await collect(debate.run("What is our MRR?"));

    expect(engine.sentPrompts.length).toBeGreaterThan(0);
    for (const p of engine.sentPrompts) {
      expect(p.prompt).toContain("[REFERENCE DOCUMENTS]");
      expect(p.prompt).toContain("73471");
    }
  });

  it("leaves prompts unchanged when no referenceDocuments are configured", async () => {
    const experts = [expert("alpha")];
    const engine = await makeEngine(experts);

    const config: DebateConfig = {
      maxRounds: 1,
      maxWordsPerResponse: 0,
      mode: "structured",
      retryBackoffMs: [1, 2],
    };
    const debate = new Debate(engine, experts, config);
    await collect(debate.run("topic"));

    expect(engine.sentPrompts.length).toBeGreaterThan(0);
    for (const p of engine.sentPrompts) {
      expect(p.prompt).not.toContain("[REFERENCE DOCUMENTS]");
    }
  });
});
