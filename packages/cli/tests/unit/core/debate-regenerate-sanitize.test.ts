/**
 * Integration test: the regenerate-mode quality-gate path sanitizes leaked
 * tool markup from the finalized regeneration result before persisting it
 * to `turn.end` (T-PR15 / #2414).
 *
 * This test characterizes existing behavior: the `stripToolMarkup()` call at
 * `debate.ts:862` wraps the regeneration generator and sanitizes whatever
 * candidate is accepted (whether the initial response passes, a regeneration
 * passes, or the cap is hit). The test would FAIL if that sanitizer were
 * removed, proving the regenerate path has coverage.
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

/**
 * Minimal CouncilEngine that returns a SEQUENCE of responses per expert.
 * Used to script distinct responses for successive sends to the same expert
 * (e.g., initial response + regeneration).
 */
class ScriptedEngine implements CouncilEngine {
  readonly #experts = new Set<string>();
  readonly #queues: Map<string, readonly string[]>;
  readonly #sendCounts = new Map<string, number>();

  constructor(opts: { readonly responses: Readonly<Record<string, readonly string[]>> }) {
    this.#queues = new Map(Object.entries(opts.responses));
  }

  async start(): Promise<void> {
    /* no-op */
  }
  async stop(): Promise<void> {
    /* no-op */
  }
  async addExpert(spec: ExpertSpec): Promise<void> {
    this.#experts.add(spec.id);
  }
  async removeExpert(expertId: string): Promise<void> {
    this.#experts.delete(expertId);
  }
  async listModels(): Promise<readonly string[]> {
    return ["scripted"];
  }

  send(options: SendOptions): AsyncIterable<EngineEvent> {
    const n = this.#sendCounts.get(options.expertId) ?? 0;
    this.#sendCounts.set(options.expertId, n + 1);
    const queue = this.#queues.get(options.expertId) ?? [];
    const idx = Math.min(n, Math.max(0, queue.length - 1));
    const text = queue[idx] ?? "";
    return this.#stream(options.expertId, text);
  }

  async *#stream(expertId: string, text: string): AsyncGenerator<EngineEvent> {
    yield { kind: "message.delta", expertId, text };
    yield { kind: "message.complete", expertId, response: { latencyMs: 1 } };
  }
}

const expert: ExpertSpec = {
  id: "01HZ-econ",
  slug: "econ",
  displayName: "Economist",
  model: "claude-sonnet-4",
  systemMessage: "You are an economist.",
};

const FREEFORM_1R: Omit<DebateConfig, "qualityGate"> = {
  maxRounds: 1,
  maxWordsPerResponse: 50,
  mode: "freeform",
  retryBackoffMs: [1, 2],
};

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

const open = (name: string, attrs = ""): string => `<${name}${attrs}>`;
const close = (name: string): string => `<${"/"}${name}>`;

describe("Debate regenerate mode — strips tool markup from accepted candidate (T-PR15)", () => {
  it("sanitizes tool markup when the initial response passes the gate", async () => {
    // Initial response contains markup but no gate failures (passes).
    const withMarkup =
      "I disagree with the premise. " +
      open("invoke", ' name="Skill"') +
      open("parameter", ' name="q"') +
      "cpi" +
      close("parameter") +
      close("invoke") +
      " Analysis complete.";

    const engine = new ScriptedEngine({
      responses: { [expert.id]: [withMarkup] },
    });
    await engine.start();
    await engine.addExpert(expert);

    const config: DebateConfig = {
      ...FREEFORM_1R,
      qualityGate: { mode: "regenerate", maxRegenerations: 2 },
    };
    const events = await collect(new Debate(engine, [expert], config).run("topic"));
    const content = turnEndContent(events);

    // Tool markup removed by stripToolMarkup wrapper.
    expect(content).not.toContain("invoke");
    expect(content).not.toContain("parameter");
    expect(content).not.toContain("cpi");
    expect(content).toContain("I disagree with the premise.");
    expect(content).toContain("Analysis complete.");
  });

  it("sanitizes tool markup when a regeneration passes the gate", async () => {
    // Initial response fails (sycophantic), regeneration passes but has markup.
    const failing = "Great point, I agree completely and this is solid overall.";
    const passingWithMarkup =
      "I disagree with that framing. " +
      open("function_calls") +
      open("invoke", ' name="Tool"') +
      "data" +
      close("invoke") +
      close("function_calls") +
      " The conclusion is flawed.";

    const engine = new ScriptedEngine({
      responses: {
        [expert.id]: [failing, passingWithMarkup],
      },
    });
    await engine.start();
    await engine.addExpert(expert);

    const config: DebateConfig = {
      ...FREEFORM_1R,
      qualityGate: { mode: "regenerate", maxRegenerations: 2 },
    };
    const events = await collect(new Debate(engine, [expert], config).run("topic"));
    const content = turnEndContent(events);

    // Rejected initial never leaked.
    expect(content).not.toContain("Great point");
    // Regeneration's markup removed by stripToolMarkup wrapper.
    expect(content).not.toContain("function_calls");
    expect(content).not.toContain("invoke");
    expect(content).not.toContain("data");
    expect(content).toContain("I disagree with that framing.");
    expect(content).toContain("The conclusion is flawed.");
  });

  it("sanitizes tool markup when the regeneration cap is hit", async () => {
    // All candidates fail the gate; last is accepted with markup.
    const syco1 = "Great point, I agree with the previous analysis overall.";
    const syco2 = "Solid approach, echoing the robust and holistic synergy here.";
    const syco3WithMarkup =
      "Well said indeed. " +
      open("antml:invoke", ' name="search"') +
      "query" +
      close("antml:invoke") +
      " Great insights.";

    const engine = new ScriptedEngine({
      responses: {
        [expert.id]: [syco1, syco2, syco3WithMarkup],
      },
    });
    await engine.start();
    await engine.addExpert(expert);

    const config: DebateConfig = {
      ...FREEFORM_1R,
      qualityGate: { mode: "regenerate", maxRegenerations: 2 },
    };
    const events = await collect(new Debate(engine, [expert], config).run("topic"));
    const content = turnEndContent(events);

    // Last candidate accepted after cap, markup sanitized.
    expect(content).toContain("Well said indeed.");
    expect(content).toContain("Great insights.");
    expect(content).not.toContain("antml:invoke");
    expect(content).not.toContain("search");
    expect(content).not.toContain("query");
    // Earlier candidates never leaked.
    expect(content).not.toContain("previous analysis");
    expect(content).not.toContain("holistic synergy");
  });
});
