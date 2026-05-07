/**
 * Tests for the CouncilEngine domain types and interface module.
 *
 * The interface itself is a TypeScript-only construct (erased at runtime),
 * but the module must:
 *   1. Be importable from src/engine/index.ts
 *   2. Re-export every domain type from src/engine/types.ts
 *   3. Provide type-level guarantees verified by tsc — concrete fixture
 *      objects below force structural type-checking on every test run.
 *
 * These tests fail (cannot resolve module) until the engine module lands.
 */
import { describe, expect, it } from "vitest";

import * as engine from "../../../src/engine/index.js";
import type {
  EngineEvent,
  EngineResponse,
  ExpertSpec,
  SendOptions,
} from "../../../src/engine/index.js";

describe("CouncilEngine module", () => {
  it("imports without throwing", () => {
    expect(engine).toBeDefined();
  });

  it("exposes the expected named types via re-export", () => {
    const spec: ExpertSpec = {
      id: "01HZ123",
      slug: "skeptic",
      displayName: "The Skeptic",
      model: "claude-sonnet-4",
      systemMessage: "You are a skeptical reviewer.",
    };
    expect(spec.slug).toBe("skeptic");

    const send: SendOptions = {
      prompt: "What could go wrong?",
      expertId: "01HZ123",
    };
    expect(send.expertId).toBe("01HZ123");

    const response: EngineResponse = {
      content: "Many things.",
      latencyMs: 42,
    };
    expect(response.latencyMs).toBe(42);

    const delta: EngineEvent = {
      kind: "message.delta",
      expertId: "01HZ123",
      text: "Hmm",
    };
    expect(delta.kind).toBe("message.delta");

    const complete: EngineEvent = {
      kind: "message.complete",
      expertId: "01HZ123",
      response,
    };
    expect(complete.kind).toBe("message.complete");

    const errorEvent: EngineEvent = {
      kind: "error",
      expertId: "01HZ123",
      error: new Error("boom"),
      recoverable: false,
    };
    expect(errorEvent.recoverable).toBe(false);
  });

  it("ExpertSpec.reasoningEffort is optional and accepts low/medium/high", () => {
    const withEffort: ExpertSpec = {
      id: "01HZ124",
      slug: "deep",
      displayName: "Deep Thinker",
      model: "claude-opus-4",
      systemMessage: "Think hard.",
      reasoningEffort: "high",
    };
    expect(withEffort.reasoningEffort).toBe("high");
  });

  it("EngineResponse fields tokensIn and tokensOut are optional", () => {
    const minimal: EngineResponse = { content: "ok", latencyMs: 1 };
    expect(minimal.tokensIn).toBeUndefined();

    const full: EngineResponse = {
      content: "ok",
      latencyMs: 1,
      tokensIn: 10,
      tokensOut: 20,
    };
    expect(full.tokensIn).toBe(10);
    expect(full.tokensOut).toBe(20);
  });
});
