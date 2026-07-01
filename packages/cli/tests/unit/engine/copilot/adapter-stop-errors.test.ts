/**
 * Adapter-level stop-error aggregation + `Error.cause` preservation (#148).
 *
 * Counterpart to the MockEngine coverage in `tests/unit/operational-risks.test.ts`
 * (#143). That file proves the in-memory MockEngine collects per-session
 * disconnect failures into `lastStopErrors`; this file proves the REAL SDK
 * adapter (`src/engine/copilot/adapter.ts`) does the same across BOTH teardown
 * paths — per-expert `CopilotSession.disconnect()` AND the final
 * `CopilotClient.stop()` — and that every collected error PRESERVES the original
 * throwable as `Error.cause`.
 *
 * Why a focused sibling file (not the shared `adapter.test.ts`, not
 * `operational-risks.test.ts`):
 *  - The shared `adapter.test.ts` mock marks sessions disconnected but cannot
 *    REJECT on `disconnect()`; teaching it to would perturb the ~50 tests that
 *    depend on that mock. A self-contained stub keeps a tight file-scope lock.
 *  - `operational-risks.test.ts` drives MockEngine/convene/persister and must not
 *    gain a file-wide `vi.mock("@github/copilot-sdk")`.
 *
 * The SDK is stubbed via `vi.mock`, not imported: the ESLint `no-restricted-imports`
 * boundary restricts the real `@github/copilot-sdk` to `engine/copilot/` SOURCE,
 * and a `vi.mock` path string is not an import, so this test stays compliant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExpertSpec } from "../../../../src/engine/index.js";

// Vitest hoists `vi.mock` above imports; its factory may only reference
// out-of-scope variables whose names begin with `mock`. Hence `mockStopState`.
interface MockStopState {
  /** Per-model throwable that `CopilotSession.disconnect()` rejects with. */
  readonly disconnectRejections: Map<string, unknown>;
  /** When set, `CopilotClient.stop()` rejects with `.value` (any throwable). */
  clientStopRejection: { readonly value: unknown } | undefined;
  /** Count of `CopilotClient.stop()` invocations — proves teardown ran. */
  stopCalls: number;
}

const mockStopState: MockStopState = {
  disconnectRejections: new Map<string, unknown>(),
  clientStopRejection: undefined,
  stopCalls: 0,
};

vi.mock("@github/copilot-sdk", () => {
  let sessionSeq = 0;

  class MockCopilotSession {
    readonly id: string;
    readonly model: string;
    constructor(id: string, model: string) {
      this.id = id;
      this.model = model;
    }
    async disconnect(): Promise<void> {
      // `.has()` semantics so a falsy throwable still rejects.
      if (mockStopState.disconnectRejections.has(this.model)) {
        throw mockStopState.disconnectRejections.get(this.model);
      }
    }
  }

  class MockCopilotClient {
    async start(): Promise<void> {
      /* no-op: the CLI-path resolver in start() is best-effort */
    }
    async stop(): Promise<void> {
      mockStopState.stopCalls += 1;
      if (mockStopState.clientStopRejection !== undefined) {
        throw mockStopState.clientStopRejection.value;
      }
    }
    async createSession(opts: {
      model: string;
      systemMessage?: { content: string };
      onPermissionRequest: unknown;
      availableTools?: string[];
    }): Promise<MockCopilotSession> {
      return new MockCopilotSession(`session-${sessionSeq++}`, opts.model);
    }
    async listModels(): Promise<{ id: string }[]> {
      return [];
    }
  }

  return { CopilotClient: MockCopilotClient, CopilotSession: MockCopilotSession };
});

// Import AFTER vi.mock so the adapter binds to the stub SDK.
const { CopilotEngine } = await import("../../../../src/engine/copilot/adapter.js");

// Distinct models let the stub target each expert's disconnect independently.
const expertA: ExpertSpec = {
  id: "01HZ-cto",
  slug: "cto",
  displayName: "CTO",
  model: "claude-sonnet-4.5",
  systemMessage: "You are a CTO.",
};
const expertB: ExpertSpec = {
  id: "01HZ-pm",
  slug: "pm",
  displayName: "PM",
  model: "gpt-5.4",
  systemMessage: "You are a PM.",
};

function resetStopMock(): void {
  mockStopState.disconnectRejections.clear();
  mockStopState.clientStopRejection = undefined;
  mockStopState.stopCalls = 0;
}

describe("CopilotEngine #148 — stop-error aggregation + Error.cause preservation", () => {
  beforeEach(() => {
    resetStopMock();
  });

  it("aggregates every disconnect failure AND the client.stop failure, preserving each Error.cause", async () => {
    const causeA = new Error("expert-A socket already closed");
    const causeB = new Error("expert-B disconnect timed out");
    const causeClient = new Error("client transport hung up");
    mockStopState.disconnectRejections.set(expertA.model, causeA);
    mockStopState.disconnectRejections.set(expertB.model, causeB);
    mockStopState.clientStopRejection = { value: causeClient };

    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    await engine.addExpert(expertB);

    // stop() must still resolve to void despite three underlying rejections.
    await expect(engine.stop()).resolves.toBeUndefined();

    const errors = engine.lastStopErrors;

    // Discriminating count + ordered messages: disconnects (in expert-insertion
    // order) precede the terminal client.stop() failure.
    expect(errors).toHaveLength(3);
    expect(errors.map((e) => e.message)).toEqual([
      `expert ${expertA.id}: ${causeA.message}`,
      `expert ${expertB.id}: ${causeB.message}`,
      `CopilotClient.stop(): ${causeClient.message}`,
    ]);

    // Each wrapper preserves the ORIGINAL throwable as `cause` (identity, not copy).
    expect(errors[0]?.cause).toBe(causeA);
    expect(errors[1]?.cause).toBe(causeB);
    expect(errors[2]?.cause).toBe(causeClient);

    // Client teardown was actually attempted after the disconnect failures.
    expect(mockStopState.stopCalls).toBe(1);
  });

  it("collects only the failing path when one disconnect rejects and client.stop succeeds", async () => {
    const causeA = new Error("only expert-A fails to disconnect");
    mockStopState.disconnectRejections.set(expertA.model, causeA);

    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    await engine.addExpert(expertB); // model gpt-5.4 → disconnects cleanly

    await engine.stop();

    const errors = engine.lastStopErrors;
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe(`expert ${expertA.id}: ${causeA.message}`);
    expect(errors[0]?.cause).toBe(causeA);
    // The clean expert contributes nothing; client.stop() succeeded.
    expect(errors.some((e) => e.message.includes(`expert ${expertB.id}`))).toBe(false);
    expect(mockStopState.stopCalls).toBe(1);
  });

  it("wraps a NON-Error disconnect rejection via String(err) with no cause", async () => {
    const raw = "ECONNRESET"; // a non-Error throwable
    mockStopState.disconnectRejections.set(expertA.model, raw);

    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);

    await engine.stop();

    const errors = engine.lastStopErrors;
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe(`expert ${expertA.id}: ${raw}`);
    // Non-Error throwables carry no cause chain — only Errors set `cause`.
    expect(errors[0]?.cause).toBeUndefined();
  });

  it("leaves lastStopErrors empty after a clean stop() (harness discrimination)", async () => {
    const engine = new CopilotEngine();
    await engine.start();
    await engine.addExpert(expertA);
    await engine.addExpert(expertB);

    await engine.stop();

    expect(engine.lastStopErrors).toEqual([]);
    expect(mockStopState.stopCalls).toBe(1);
  });
});
