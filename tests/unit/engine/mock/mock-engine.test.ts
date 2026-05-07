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
      responses: { "01HZ-cto": "response that will be cut short" },
      // ensure deltas don't all arrive synchronously
      deltaDelayMs: 50,
    });
    await engine.start();
    await engine.addExpert(expertSpec);

    const events: EngineEvent[] = [];
    const stream = engine.send({ prompt: "x", expertId: "01HZ-cto" });
    const collectPromise = (async () => {
      for await (const event of stream) {
        events.push(event);
      }
    })();
    // Stop before the response could complete
    await new Promise((resolve) => setTimeout(resolve, 5));
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
      responses: { "01HZ-cto": "some response" },
      deltaDelayMs: 50,
    });
    await engine.start();
    await engine.addExpert(expertSpec);

    const events: EngineEvent[] = [];
    const stream = engine.send({ prompt: "x", expertId: "01HZ-cto" });
    const collectPromise = (async () => {
      for await (const event of stream) {
        events.push(event);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 5));
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
