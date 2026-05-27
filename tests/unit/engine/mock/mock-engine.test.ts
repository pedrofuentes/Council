/**
 * Tests for MockEngine — the deterministic, in-memory CouncilEngine
 * implementation used by every unit test in the project.
 *
 * MockEngine MUST satisfy every clause of the CouncilEngine contract
 * (lifecycle, idempotency, cancellation, error semantics) so that consumers
 * can write tests against it with confidence that real adapters will
 * behave the same way.
 *
 * RED at this commit: ../../../src/engine/mock/mock-engine.js does not
 * yet exist; the import fails to resolve.
 */
import { describe, expect, it, beforeEach } from "vitest";

import type {
  EngineEvent,
  EngineResponse,
  ExpertSpec,
} from "../../../../src/engine/index.js";
import { MockEngine, isRecoverable } from "../../../../src/engine/mock/mock-engine.js";

const expertSpec: ExpertSpec = {
  id: "01HZ-cto",
  slug: "cto",
  displayName: "CTO",
  model: "mock-model",
  systemMessage: "You are a CTO.",
};

async function collect(stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("MockEngine — lifecycle", () => {
  it("start() and stop() resolve", async () => {
    const engine = new MockEngine();
    await engine.start();
    await engine.stop();
  });

  it("start() is idempotent (safe to call multiple times)", async () => {
    const engine = new MockEngine();
    await engine.start();
    await engine.start();
    await engine.stop();
  });

  it("stop() is idempotent (safe to call multiple times)", async () => {
    const engine = new MockEngine();
    await engine.start();
    await engine.stop();
    await engine.stop();
  });

  it("listModels() returns ['mock-model']", async () => {
    const engine = new MockEngine();
    expect(await engine.listModels()).toEqual(["mock-model"]);
  });
});

describe("MockEngine — expert registration", () => {
  let engine: MockEngine;

  beforeEach(async () => {
    engine = new MockEngine();
    await engine.start();
  });

  it("addExpert() registers a new expert", async () => {
    await expect(engine.addExpert(expertSpec)).resolves.toBeUndefined();
  });

  it("addExpert() throws on duplicate id", async () => {
    await engine.addExpert(expertSpec);
    await expect(engine.addExpert(expertSpec)).rejects.toThrow(/already registered/i);
  });

  it("removeExpert() drops a registered expert", async () => {
    await engine.addExpert(expertSpec);
    await expect(engine.removeExpert(expertSpec.id)).resolves.toBeUndefined();
    // After removal, can re-add same id without error
    await expect(engine.addExpert(expertSpec)).resolves.toBeUndefined();
  });

  it("removeExpert() of unknown id is a no-op", async () => {
    await expect(engine.removeExpert("never-existed")).resolves.toBeUndefined();
  });
});

describe("MockEngine — send (success path)", () => {
  let engine: MockEngine;

  beforeEach(async () => {
    engine = new MockEngine({
      responses: { "01HZ-cto": "I recommend a modular monolith." },
    });
    await engine.start();
    await engine.addExpert(expertSpec);
  });

  it("yields message.delta chunks then exactly one message.complete", async () => {
    const events = await collect(engine.send({ prompt: "thoughts?", expertId: "01HZ-cto" }));
    const deltas = events.filter((e) => e.kind === "message.delta");
    const completes = events.filter((e) => e.kind === "message.complete");
    const errors = events.filter((e) => e.kind === "error");
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(completes).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });

  it("delta texts concatenate to the configured response", async () => {
    const events = await collect(engine.send({ prompt: "thoughts?", expertId: "01HZ-cto" }));
    const assembled = events
      .filter((e): e is Extract<EngineEvent, { kind: "message.delta" }> => e.kind === "message.delta")
      .map((e) => e.text)
      .join("");
    expect(assembled).toBe("I recommend a modular monolith.");
  });

  it("message.complete is the terminal event (nothing yielded after it)", async () => {
    const events = await collect(engine.send({ prompt: "thoughts?", expertId: "01HZ-cto" }));
    expect(events[events.length - 1]?.kind).toBe("message.complete");
  });

  it("EngineResponse has latencyMs and tokensIn/Out (deterministic in mock)", async () => {
    const events = await collect(engine.send({ prompt: "thoughts?", expertId: "01HZ-cto" }));
    const completeEvent = events.find(
      (e): e is Extract<EngineEvent, { kind: "message.complete" }> => e.kind === "message.complete",
    );
    expect(completeEvent).toBeDefined();
    if (!completeEvent) return;
    const response: EngineResponse = completeEvent.response;
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
    expect(response.tokensIn).toBeGreaterThan(0);
    expect(response.tokensOut).toBeGreaterThan(0);
  });

  it("returns deterministic response for repeated sends", async () => {
    const a = await collect(engine.send({ prompt: "thoughts?", expertId: "01HZ-cto" }));
    const b = await collect(engine.send({ prompt: "thoughts?", expertId: "01HZ-cto" }));
    const aText = a
      .filter((e): e is Extract<EngineEvent, { kind: "message.delta" }> => e.kind === "message.delta")
      .map((e) => e.text)
      .join("");
    const bText = b
      .filter((e): e is Extract<EngineEvent, { kind: "message.delta" }> => e.kind === "message.delta")
      .map((e) => e.text)
      .join("");
    expect(aText).toBe(bText);
  });
});

describe("MockEngine — send (error paths)", () => {
  it("throws synchronously when expertId is unknown", async () => {
    const engine = new MockEngine();
    await engine.start();
    expect(() => engine.send({ prompt: "x", expertId: "never-registered" })).toThrow(
      /not registered/i,
    );
  });

  it("when configured to fail, yields a terminal error event", async () => {
    const engine = new MockEngine({
      failures: { "01HZ-cto": { code: "RATE_LIMITED", message: "Quota exhausted" } },
    });
    await engine.start();
    await engine.addExpert(expertSpec);
    const events = await collect(engine.send({ prompt: "go", expertId: "01HZ-cto" }));
    const last = events[events.length - 1];
    expect(last?.kind).toBe("error");
    if (last?.kind === "error") {
      expect(last.error.code).toBe("RATE_LIMITED");
      expect(last.recoverable).toBe(true); // RATE_LIMITED is recoverable per isRecoverable()
    }
  });
});

describe("MockEngine — cancellation contract", () => {
  it("aborted signal yields terminal ABORTED error promptly", async () => {
    const engine = new MockEngine({
      responses: { "01HZ-cto": "long response that would otherwise stream" },
    });
    await engine.start();
    await engine.addExpert(expertSpec);

    const controller = new AbortController();
    controller.abort(); // pre-abort
    const events = await collect(
      engine.send({ prompt: "x", expertId: "01HZ-cto", signal: controller.signal }),
    );
    const last = events[events.length - 1];
    expect(last?.kind).toBe("error");
    if (last?.kind === "error") {
      expect(last.error.code).toBe("ABORTED");
      expect(last.recoverable).toBe(false);
    }
  });

  it("stop() aborts in-flight sends with ABORTED error", async () => {
    const engine = new MockEngine({
      // Multi-sentence response so chunkResponse() emits multiple deltas;
      // combined with deltaDelayMs this guarantees a window between the
      // first delta and the natural completion.
      responses: { "01HZ-cto": "First sentence. Second sentence. Third sentence. Fourth." },
      deltaDelayMs: 50,
    });
    await engine.start();
    await engine.addExpert(expertSpec);

    const events: EngineEvent[] = [];
    const stream = engine.send({ prompt: "x", expertId: "01HZ-cto" });
    let firstDeltaResolved: (() => void) | undefined;
    const firstDelta = new Promise<void>((resolve) => {
      firstDeltaResolved = resolve;
    });
    const collectPromise = (async () => {
      for await (const event of stream) {
        events.push(event);
        if (event.kind === "message.delta") firstDeltaResolved?.();
      }
    })();
    // Wait for the first delta to arrive so we KNOW the stream is mid-flight.
    await firstDelta;
    await engine.stop();
    await collectPromise;

    const last = events[events.length - 1];
    expect(last?.kind).toBe("error");
    if (last?.kind === "error") {
      expect(last.error.code).toBe("ABORTED");
    }
  });

  it("removeExpert() aborts in-flight send for that expert", async () => {
    const engine = new MockEngine({
      responses: { "01HZ-cto": "First sentence. Second sentence. Third sentence. Fourth." },
      deltaDelayMs: 50,
    });
    await engine.start();
    await engine.addExpert(expertSpec);

    const events: EngineEvent[] = [];
    const stream = engine.send({ prompt: "x", expertId: "01HZ-cto" });
    let firstDeltaResolved: (() => void) | undefined;
    const firstDelta = new Promise<void>((resolve) => {
      firstDeltaResolved = resolve;
    });
    const collectPromise = (async () => {
      for await (const event of stream) {
        events.push(event);
        if (event.kind === "message.delta") firstDeltaResolved?.();
      }
    })();
    await firstDelta;
    await engine.removeExpert("01HZ-cto");
    await collectPromise;

    const last = events[events.length - 1];
    expect(last?.kind).toBe("error");
    if (last?.kind === "error") {
      expect(last.error.code).toBe("ABORTED");
    }
  });
});

describe("isRecoverable() helper", () => {
  it("RATE_LIMITED and NETWORK are recoverable", () => {
    expect(isRecoverable("RATE_LIMITED")).toBe(true);
    expect(isRecoverable("NETWORK")).toBe(true);
  });

  it("ABORTED, NOT_AUTHENTICATED, MODEL_UNAVAILABLE, CONTEXT_OVERFLOW, PROVIDER_ERROR, INTERNAL are not recoverable", () => {
    expect(isRecoverable("ABORTED")).toBe(false);
    expect(isRecoverable("NOT_AUTHENTICATED")).toBe(false);
    expect(isRecoverable("MODEL_UNAVAILABLE")).toBe(false);
    expect(isRecoverable("CONTEXT_OVERFLOW")).toBe(false);
    expect(isRecoverable("PROVIDER_ERROR")).toBe(false);
    expect(isRecoverable("INTERNAL")).toBe(false);
  });
});

describe("MockEngine — synthesizer responses", () => {
  it("returns valid JSON for synthesizer expert (conclude command)", async () => {
    const engine = new MockEngine();
    const synthesizerSpec: ExpertSpec = {
      id: "01HZ-synth",
      slug: "synthesizer",
      displayName: "Council Synthesizer",
      model: "mock-model",
      systemMessage: "You are a deliberation synthesizer.",
    };

    await engine.start();
    await engine.addExpert(synthesizerSpec);

    const events = await collect(
      engine.send({ prompt: "Analyze this debate.", expertId: "01HZ-synth" }),
    );

    const deltas = events.filter((e) => e.kind === "message.delta");
    expect(deltas.length).toBeGreaterThan(0);

    const responseText = deltas.map((e) => (e.kind === "message.delta" ? e.text : "")).join("");
    expect(responseText).toBeTruthy();

    // Must be valid JSON
    const parsed = JSON.parse(responseText);
    expect(parsed).toHaveProperty("consensus");
    expect(parsed).toHaveProperty("tensions");
    expect(parsed).toHaveProperty("decisionMatrix");
    expect(parsed).toHaveProperty("recommendation");
    expect(parsed).toHaveProperty("confidence");

    expect(Array.isArray(parsed.consensus)).toBe(true);
    expect(Array.isArray(parsed.tensions)).toBe(true);
    expect(Array.isArray(parsed.decisionMatrix)).toBe(true);
    expect(typeof parsed.recommendation).toBe("string");
    expect(["high", "medium", "low"]).toContain(parsed.confidence);

    await engine.stop();
  });

  it("returns plain text for non-synthesizer experts", async () => {
    const engine = new MockEngine();
    await engine.start();
    await engine.addExpert(expertSpec);

    const events = await collect(engine.send({ prompt: "Hello", expertId: "01HZ-cto" }));

    const deltas = events.filter((e) => e.kind === "message.delta");
    const responseText = deltas.map((e) => (e.kind === "message.delta" ? e.text : "")).join("");

    expect(responseText).toBe("[mock response from 01HZ-cto]");

    await engine.stop();
  });
});

describe("MockEngine — profile analyzer responses", () => {
  it("returns parseable persona-profile JSON for profile analyzer experts", async () => {
    // Mirrors the registration done by `analyzeDocuments` in
    // src/core/documents/profile-analyzer.ts: the transient expert is
    // registered with a slug prefixed `__profile-analyzer-` so the
    // mock engine must recognise that and return JSON matching the
    // schema the analyzer parses.
    const engine = new MockEngine();
    const analyzerSpec: ExpertSpec = {
      id: "01HZ-analyzer",
      slug: "__profile-analyzer-01HZ-analyzer",
      displayName: "Profile Analyzer",
      model: "mock-model",
      systemMessage: "You are a persona profile analyzer.",
    };

    await engine.start();
    await engine.addExpert(analyzerSpec);

    const events = await collect(
      engine.send({ prompt: "Analyze these documents.", expertId: "01HZ-analyzer" }),
    );

    const deltas = events.filter((e) => e.kind === "message.delta");
    expect(deltas.length).toBeGreaterThan(0);

    const responseText = deltas
      .map((e) => (e.kind === "message.delta" ? e.text : ""))
      .join("");
    expect(responseText).toBeTruthy();

    // Must parse and satisfy the profile-analyzer schema: the analyzer
    // rejects responses whose `communicationStyle` or `epistemicStance`
    // are empty, which would trigger the "unparsable JSON after retry"
    // failure that this fix targets.
    const parsed: unknown = JSON.parse(responseText);
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe("object");
    const obj = parsed as Record<string, unknown>;

    expect(typeof obj["communicationStyle"]).toBe("string");
    expect((obj["communicationStyle"] as string).length).toBeGreaterThan(0);
    expect(typeof obj["epistemicStance"]).toBe("string");
    expect((obj["epistemicStance"] as string).length).toBeGreaterThan(0);

    expect(Array.isArray(obj["decisionPatterns"])).toBe(true);
    expect(Array.isArray(obj["biases"])).toBe(true);
    expect(Array.isArray(obj["vocabulary"])).toBe(true);

    await engine.stop();
  });
});


