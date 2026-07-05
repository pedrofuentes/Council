/**
 * Integration test: the Debate orchestrator strips leaked tool/skill-invocation
 * markup from an expert's finalized response before it is emitted on `turn.end`
 * (F-12 / T-08).
 *
 * `turn.end.content` is the single "finalized expert message content" chokepoint:
 * the DebatePersister writes it verbatim to the transcript DB, and renderers
 * fall back to it. Sanitizing the ACCUMULATED content (not per-chunk) means
 * markup split across streaming delta boundaries is still caught, and the
 * non-streaming mock path is unaffected for ordinary prose.
 */
import { describe, expect, it } from "vitest";

import { Debate, type DebateConfig } from "../../../src/core/debate.js";
import type { DebateEvent } from "../../../src/core/types.js";
import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../src/engine/index.js";
import { ScriptedEngine } from "../../helpers/scripted-engine.js";

const expert: ExpertSpec = {
  id: "01HZ-econ",
  slug: "econ",
  displayName: "Economist",
  model: "claude-sonnet-4",
  systemMessage: "You are an economist.",
};

const FREEFORM_1R: DebateConfig = {
  maxRounds: 1,
  maxWordsPerResponse: 50,
  mode: "freeform",
  retryBackoffMs: [1, 2],
};

const open = (name: string, attrs = ""): string => `<${name}${attrs}>`;
const close = (name: string): string => `<${"/"}${name}>`;

async function collect(stream: AsyncIterable<DebateEvent>): Promise<DebateEvent[]> {
  const out: DebateEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

function turnEndContent(events: readonly DebateEvent[]): string {
  const end = events.find(
    (e): e is Extract<DebateEvent, { kind: "turn.end" }> => e.kind === "turn.end",
  );
  if (!end) throw new Error("no turn.end event was emitted");
  return end.content;
}

/**
 * Emits a single expert response as a fixed sequence of `message.delta`
 * chunks, so a test can prove that markup split across delta boundaries is
 * still sanitized once the debate accumulates the full content.
 */
class ChunkedEngine implements CouncilEngine {
  readonly #chunks: readonly string[];
  constructor(chunks: readonly string[]) {
    this.#chunks = chunks;
  }
  async start(): Promise<void> {
    /* no-op */
  }
  async stop(): Promise<void> {
    /* no-op */
  }
  async addExpert(): Promise<void> {
    /* no-op */
  }
  async removeExpert(): Promise<void> {
    /* no-op */
  }
  async listModels(): Promise<readonly string[]> {
    return ["chunked"];
  }
  send(options: SendOptions): AsyncIterable<EngineEvent> {
    const chunks = this.#chunks;
    const expertId = options.expertId;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
        for (const text of chunks) {
          yield { kind: "message.delta", expertId, text };
        }
        yield { kind: "message.complete", expertId, response: { latencyMs: 1 } };
      },
    };
  }
}

describe("Debate — strips leaked tool markup from turn.end content (T-08)", () => {
  it("removes a leaked invoke/parameter block from the finalized turn.end content", async () => {
    const leaked =
      "Inflation is complex. " +
      open("invoke", ' name="Skill"') +
      open("parameter", ' name="q"') +
      "cpi" +
      close("parameter") +
      close("invoke") +
      " Rates matter.";
    const engine = new ScriptedEngine({
      scripts: { [expert.id]: [{ kind: "content", text: leaked }] },
    });
    await engine.start();
    await engine.addExpert(expert);

    const events = await collect(new Debate(engine, [expert], FREEFORM_1R).run("topic"));
    const content = turnEndContent(events);

    expect(content).not.toContain("invoke");
    expect(content).not.toContain("parameter");
    expect(content).not.toContain("cpi");
    expect(content).toContain("Inflation is complex.");
    expect(content).toContain("Rates matter.");
  });

  it("sanitizes tool markup split across streaming delta chunks (accumulated, not per-chunk)", async () => {
    const full =
      "Analysis. " +
      open("invoke", ' name="Skill"') +
      open("parameter", ' name="q"') +
      "x" +
      close("parameter") +
      close("invoke") +
      " Conclusion.";
    // Slice the full response into chunks so a tag is split across boundaries.
    const size = 7;
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += size) {
      chunks.push(full.slice(i, i + size));
    }
    // Sanity: the opening invoke tag must actually straddle a chunk boundary.
    expect(chunks.some((c) => c.includes(open("invoke", ' name="Skill"')))).toBe(false);

    const engine = new ChunkedEngine(chunks);
    await engine.start();
    await engine.addExpert(expert);

    const events = await collect(new Debate(engine, [expert], FREEFORM_1R).run("topic"));
    const content = turnEndContent(events);

    expect(content).not.toContain("invoke");
    expect(content).not.toContain("parameter");
    expect(content).toContain("Analysis.");
    expect(content).toContain("Conclusion.");
  });

  it("leaves ordinary prose untouched end to end (mock path unaffected)", async () => {
    const normal = "Supply shocks drive inflation. The bank should act cautiously.";
    const engine = new ScriptedEngine({
      scripts: { [expert.id]: [{ kind: "content", text: normal }] },
    });
    await engine.start();
    await engine.addExpert(expert);

    const events = await collect(new Debate(engine, [expert], FREEFORM_1R).run("topic"));
    expect(turnEndContent(events)).toBe(normal);
  });
});
