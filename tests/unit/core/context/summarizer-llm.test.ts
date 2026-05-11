/**
 * Tests for `buildLLMSummary()` — the LLM-backed alternative to the
 * heuristic rolling summarizer (ROADMAP §2.6).
 *
 * The LLM summarizer delegates summarization to an engine: it registers
 * a temporary "summarizer" expert with a system prompt that frames the
 * task, sends the formatted prior turns as a user prompt, collects the
 * streamed response, and tears the expert back down.
 *
 * RED at this commit: `buildLLMSummary` does not exist.
 */
import { describe, expect, it } from "vitest";

import {
  buildHeuristicSummary,
  buildLLMSummary,
  type SummarizerConfig,
} from "../../../../src/core/context/summarizer.js";
import type {
  CouncilEngine,
  EngineEvent,
  ExpertSpec,
  SendOptions,
} from "../../../../src/engine/index.js";
import type { PriorTurnRecord } from "../../../../src/core/moderator/strategy.js";

interface RecordedSend {
  readonly expertId: string;
  readonly prompt: string;
}

class RecordingEngine implements CouncilEngine {
  readonly registered: ExpertSpec[] = [];
  readonly removed: string[] = [];
  readonly sends: RecordedSend[] = [];
  readonly responseChunks: readonly string[];

  constructor(responseChunks: readonly string[]) {
    this.responseChunks = responseChunks;
  }

  async start(): Promise<void> {
    /* no-op */
  }
  async stop(): Promise<void> {
    /* no-op */
  }
  async addExpert(spec: ExpertSpec): Promise<void> {
    this.registered.push(spec);
  }
  async removeExpert(expertId: string): Promise<void> {
    this.removed.push(expertId);
  }
  async listModels(): Promise<readonly string[]> {
    return ["stub"];
  }

  send(opts: SendOptions): AsyncIterable<EngineEvent> {
    this.sends.push({ expertId: opts.expertId, prompt: opts.prompt });
    const expertId = opts.expertId;
    const chunks = this.responseChunks;
    return (async function* (): AsyncGenerator<EngineEvent, void, void> {
      for (const text of chunks) {
        yield { kind: "message.delta", expertId, text };
      }
      yield {
        kind: "message.complete",
        expertId,
        response: { latencyMs: 1, tokensIn: 1, tokensOut: 1 },
      };
    })();
  }
}

const baseTurns: readonly PriorTurnRecord[] = [
  { expertSlug: "alpha", displayName: "Alpha", content: "We must validate falsifiability.", round: 0 },
  { expertSlug: "beta", displayName: "Beta", content: "I disagree — shipping is the test.", round: 0 },
  { expertSlug: "alpha", displayName: "Alpha", content: "But the metric is wrong.", round: 1 },
];

const cfg: SummarizerConfig = { summarizeAfterRound: 1, maxSummaryLength: 500 };

describe("buildHeuristicSummary (renamed from buildRollingSummary)", () => {
  it("is exported and produces the same heuristic summary as before", () => {
    const out = buildHeuristicSummary(baseTurns, 2, cfg);
    expect(out).toContain("Alpha");
    expect(out).toContain("Beta");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("buildLLMSummary — engine-backed summarization", () => {
  it("returns the empty string when the round threshold has not been reached", async () => {
    const engine = new RecordingEngine(["should not be called"]);
    const out = await buildLLMSummary(baseTurns, 0, cfg, engine, "gpt-test");
    expect(out).toBe("");
    expect(engine.sends.length).toBe(0);
  });

  it("returns the empty string when no prior turns exist", async () => {
    const engine = new RecordingEngine(["unused"]);
    const out = await buildLLMSummary([], 5, cfg, engine, "gpt-test");
    expect(out).toBe("");
    expect(engine.sends.length).toBe(0);
  });

  it("registers a summarizer expert, sends formatted turns, and returns the collected response", async () => {
    const engine = new RecordingEngine(["Experts disagree on ", "validation strategy."]);
    const out = await buildLLMSummary(baseTurns, 2, cfg, engine, "gpt-test");

    // Returned summary is the concatenation of streamed deltas.
    expect(out).toBe("Experts disagree on validation strategy.");

    // A summarizer expert was registered exactly once.
    expect(engine.registered.length).toBe(1);
    const summarizer = engine.registered[0]!;
    expect(summarizer.model).toBe("gpt-test");
    expect(summarizer.systemMessage.toLowerCase()).toContain("summar");

    // Exactly one send happened, against the registered summarizer.
    expect(engine.sends.length).toBe(1);
    expect(engine.sends[0]!.expertId).toBe(summarizer.id);

    // The prompt embeds each prior turn's content so the LLM can summarize.
    const prompt = engine.sends[0]!.prompt;
    expect(prompt).toContain("Alpha");
    expect(prompt).toContain("validate falsifiability");
    expect(prompt).toContain("Beta");
    expect(prompt).toContain("shipping is the test");

    // The summarizer expert was torn down after use (no leak).
    expect(engine.removed).toEqual([summarizer.id]);
  });

  it("truncates the summary to maxSummaryLength characters", async () => {
    const longChunk = "x".repeat(2000);
    const engine = new RecordingEngine([longChunk]);
    const out = await buildLLMSummary(baseTurns, 2, { ...cfg, maxSummaryLength: 50 }, engine, "gpt-test");
    expect(out.length).toBe(50);
  });

  it("removes the summarizer expert even if the engine errors mid-stream", async () => {
    class ErroringEngine extends RecordingEngine {
      override send(opts: SendOptions): AsyncIterable<EngineEvent> {
        this.sends.push({ expertId: opts.expertId, prompt: opts.prompt });
        const expertId = opts.expertId;
        return (async function* (): AsyncGenerator<EngineEvent, void, void> {
          yield { kind: "message.delta", expertId, text: "partial" };
          yield {
            kind: "error",
            expertId,
            error: { code: "PROVIDER_ERROR", message: "boom" },
            recoverable: false,
          };
        })();
      }
    }
    const engine = new ErroringEngine([]);
    const out = await buildLLMSummary(baseTurns, 2, cfg, engine, "gpt-test");
    // On engine error, return what we collected so far (best-effort), not throw.
    expect(out).toBe("partial");
    // Expert must still have been torn down.
    expect(engine.removed.length).toBe(1);
  });
});
