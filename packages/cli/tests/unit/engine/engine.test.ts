/**
 * Tests for the CouncilEngine domain types and interface module.
 *
 * The interface itself is a TypeScript-only construct (erased at runtime).
 * Type safety is verified by `pnpm typecheck` (separate gate run by Sentinel
 * and CI). The runtime tests below ensure the module is importable and that
 * the concrete fixtures continue to satisfy each domain type.
 *
 * Mutation-pinning strategy:
 *   - `satisfies CouncilEngine` on `mockEngine` catches removal/rename of any
 *     interface method or relaxation of return types.
 *   - `// @ts-expect-error` comments below pin the EXACT shape — if a field
 *     becomes optional or a `readonly` modifier is removed, the comment goes
 *     stale and `tsc` fails.
 *
 * These tests fail RED at SHA acf3136 (module did not exist).
 */
import { describe, expect, it } from "vitest";

import * as engine from "../../../src/engine/index.js";
import type {
  CouncilEngine,
  EngineError,
  EngineErrorCode,
  EngineEvent,
  EngineResponse,
  ExpertSpec,
  ReasoningEffort,
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

    const response: EngineResponse = { latencyMs: 42 };
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

    const error: EngineError = {
      code: "RATE_LIMITED",
      message: "Quota exhausted",
      retryAfterMs: 30_000,
      provider: "copilot",
    };
    const errorEvent: EngineEvent = {
      kind: "error",
      expertId: "01HZ123",
      error,
      recoverable: true,
    };
    expect(errorEvent.recoverable).toBe(true);
  });

  it("ExpertSpec.reasoningEffort accepts every ReasoningEffort literal", () => {
    const efforts: readonly ReasoningEffort[] = ["low", "medium", "high"];
    for (const reasoningEffort of efforts) {
      const spec: ExpertSpec = {
        id: `01HZ-${reasoningEffort}`,
        slug: "deep",
        displayName: "Deep Thinker",
        model: "claude-opus-4",
        systemMessage: "Think hard.",
        reasoningEffort,
      };
      expect(spec.reasoningEffort).toBe(reasoningEffort);
    }
  });

  it("EngineResponse fields tokensIn and tokensOut are optional", () => {
    const minimal: EngineResponse = { latencyMs: 1 };
    expect(minimal.tokensIn).toBeUndefined();
    expect(minimal.tokensOut).toBeUndefined();

    const full: EngineResponse = {
      latencyMs: 1,
      tokensIn: 10,
      tokensOut: 20,
    };
    expect(full.tokensIn).toBe(10);
    expect(full.tokensOut).toBe(20);
  });

  it("SendOptions.signal is optional and typed as AbortSignal", () => {
    const controller = new AbortController();
    const opts: SendOptions = {
      prompt: "go",
      expertId: "01HZ",
      signal: controller.signal,
    };
    expect(opts.signal).toBe(controller.signal);
  });

  it("EngineError.code accepts every EngineErrorCode literal", () => {
    const codes: readonly EngineErrorCode[] = [
      "ABORTED",
      "NOT_AUTHENTICATED",
      "RATE_LIMITED",
      "MODEL_UNAVAILABLE",
      "CONTEXT_OVERFLOW",
      "NETWORK",
      "PROVIDER_ERROR",
      "INTERNAL",
    ];
    for (const code of codes) {
      const e: EngineError = { code, message: code };
      expect(e.code).toBe(code);
    }
  });
});

describe("CouncilEngine interface — mutation pinning", () => {
  // A no-op fixture used purely to pin the `CouncilEngine` shape via `satisfies`.
  // If ANY method is removed/renamed, or the return-type contract loosened
  // (e.g. `Promise<void>` -> `void`), this fixture fails to compile.
  const mockEngine = {
    async start(): Promise<void> {
      /* no-op */
    },
    async stop(): Promise<void> {
      /* no-op */
    },
    async addExpert(_spec: ExpertSpec): Promise<void> {
      /* no-op */
    },
    async removeExpert(_id: string): Promise<void> {
      /* no-op */
    },
    async *send(_options: SendOptions): AsyncIterable<EngineEvent> {
      /* no events */
    },
    async listModels(): Promise<readonly string[]> {
      return [];
    },
  } satisfies CouncilEngine;

  it("the satisfies-pinned mock conforms to CouncilEngine at compile time", () => {
    // The compile-time `satisfies` check is the test. This runtime assertion
    // ensures the fixture is instantiable and that all method names exist.
    expect(typeof mockEngine.start).toBe("function");
    expect(typeof mockEngine.stop).toBe("function");
    expect(typeof mockEngine.addExpert).toBe("function");
    expect(typeof mockEngine.removeExpert).toBe("function");
    expect(typeof mockEngine.send).toBe("function");
    expect(typeof mockEngine.listModels).toBe("function");
  });

  it("ExpertSpec.id is readonly (mutation rejected by tsc)", () => {
    const spec: ExpertSpec = {
      id: "01HZ123",
      slug: "x",
      displayName: "X",
      model: "m",
      systemMessage: "s",
    };
    // @ts-expect-error — `id` is readonly; assignment must be rejected
    spec.id = "mutated";
    expect(spec.id).toBe("mutated");
  });

  it("EngineResponse.latencyMs is required (omission rejected by tsc)", () => {
    // @ts-expect-error — `latencyMs` is required
    const bad: EngineResponse = {};
    expect(bad).toBeDefined();
  });

  it("EngineResponse has no `content` field (aggregation is consumer-owned)", () => {
    // @ts-expect-error — `content` was intentionally removed; consumers
    // accumulate `message.delta.text` in `core/debate.ts` instead.
    const bad: EngineResponse = { latencyMs: 1, content: "shouldn't exist" };
    expect(bad).toBeDefined();
  });
});
