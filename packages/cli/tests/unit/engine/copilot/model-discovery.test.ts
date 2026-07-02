/**
 * Tests for standalone Copilot model discovery.
 *
 * The SDK is mocked so discovery can be exercised without a real Copilot
 * subscription or a running engine instance.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KNOWN_MODELS } from "../../../../src/engine/models.js";

interface MockModelInfo {
  readonly id: string;
  readonly name: string;
  readonly capabilities: Record<string, never>;
}

interface MockClientState {
  startCalls: number;
  stopCalls: number;
  forceStopCalls: number;
  listModelsCalls: number;
  listModelsResults: MockModelInfo[];
  startError: Error | undefined;
  /** When true, `start()` never settles — emulates a subprocess stuck mid-handshake past the deadline (#1899). */
  startStalls: boolean;
  listModelsError: Error | undefined;
  stopError: Error | undefined;
  forceStopError: Error | undefined;
}

const mockState: MockClientState = {
  startCalls: 0,
  stopCalls: 0,
  forceStopCalls: 0,
  listModelsCalls: 0,
  listModelsResults: [],
  startError: undefined,
  startStalls: false,
  listModelsError: undefined,
  stopError: undefined,
  forceStopError: undefined,
};

vi.mock("@github/copilot-sdk", () => {
  class MockCopilotClient {
    async start(): Promise<void> {
      mockState.startCalls += 1;
      if (mockState.startError) {
        throw mockState.startError;
      }
      if (mockState.startStalls) {
        // Never settles: models the SDK's un-cancellable `start()` stuck
        // spawning/handshaking its CLI subprocess past `timeoutMs` (#1899).
        await new Promise<never>(() => undefined);
      }
    }

    async listModels(): Promise<MockModelInfo[]> {
      mockState.listModelsCalls += 1;
      if (mockState.listModelsError) {
        throw mockState.listModelsError;
      }
      return mockState.listModelsResults;
    }

    async stop(): Promise<void> {
      mockState.stopCalls += 1;
      if (mockState.stopError) {
        throw mockState.stopError;
      }
    }

    async forceStop(): Promise<void> {
      mockState.forceStopCalls += 1;
      if (mockState.forceStopError) {
        throw mockState.forceStopError;
      }
    }
  }

  return {
    CopilotClient: MockCopilotClient,
  };
});

const { discoverAvailableModels } = await import("../../../../src/engine/copilot/adapter.js");
const { discoverAvailableModels: discoverAvailableModelsFromHealth } = await import(
  "../../../../src/engine/copilot/health.js"
);

function createMockModelInfo(id: string): MockModelInfo {
  return { id, name: id, capabilities: {} };
}

function resetMockState(): void {
  mockState.startCalls = 0;
  mockState.stopCalls = 0;
  mockState.forceStopCalls = 0;
  mockState.listModelsCalls = 0;
  mockState.listModelsResults = [];
  mockState.startError = undefined;
  mockState.startStalls = false;
  mockState.listModelsError = undefined;
  mockState.stopError = undefined;
  mockState.forceStopError = undefined;
}

describe("discoverAvailableModels", () => {
  beforeEach(() => {
    resetMockState();
  });

  it("returns live frozen models from a temporary Copilot client", async () => {
    mockState.listModelsResults = [
      createMockModelInfo("claude-sonnet-4.6"),
      createMockModelInfo("gpt-5.4-mini"),
    ];

    await expect(discoverAvailableModels()).resolves.toEqual({
      models: ["claude-sonnet-4.6", "gpt-5.4-mini"],
      source: "live",
    });

    const result = await discoverAvailableModelsFromHealth();
    expect(result.source).toBe("live");
    expect(Object.isFrozen(result.models)).toBe(true);
    expect(mockState.startCalls).toBe(2);
    expect(mockState.listModelsCalls).toBe(2);
    expect(mockState.stopCalls).toBe(2);
  });

  it("falls back to a frozen static model list when SDK discovery fails", async () => {
    mockState.listModelsError = new Error("network unavailable");

    const result = await discoverAvailableModels();

    expect(result).toEqual({ models: KNOWN_MODELS, source: "static" });
    expect(Object.isFrozen(result.models)).toBe(true);
    expect(mockState.startCalls).toBe(1);
    expect(mockState.listModelsCalls).toBe(1);
    expect(mockState.stopCalls).toBe(1);
  });

  it("falls back to static models when client startup fails", async () => {
    mockState.startError = new Error("not authenticated");

    const result = await discoverAvailableModels();

    expect(result).toEqual({ models: KNOWN_MODELS, source: "static" });
    expect(Object.isFrozen(result.models)).toBe(true);
    expect(mockState.startCalls).toBe(1);
    expect(mockState.listModelsCalls).toBe(0);
    expect(mockState.stopCalls).toBe(1);
  });

  it("still returns live models when cleanup fails after successful discovery", async () => {
    mockState.listModelsResults = [createMockModelInfo("claude-opus-4.7")];
    mockState.stopError = new Error("cleanup failed");

    await expect(discoverAvailableModels()).resolves.toEqual({
      models: ["claude-opus-4.7"],
      source: "live",
    });
    expect(mockState.startCalls).toBe(1);
    expect(mockState.listModelsCalls).toBe(1);
    expect(mockState.stopCalls).toBe(1);
  });

  it("reaps the stalled subprocess via forceStop() when SDK start() exceeds the timeout", async () => {
    // start() never settles → the SDK-spawned CLI child is stuck mid-handshake.
    mockState.startStalls = true;

    const result = await discoverAvailableModels({ timeoutMs: 20 });

    // Unchanged #721 behavior: a stalled SDK still yields the static fallback...
    expect(result).toEqual({ models: KNOWN_MODELS, source: "static" });
    expect(Object.isFrozen(result.models)).toBe(true);
    // ...AND the possibly-orphaned child is deterministically reaped (#1899).
    // The timeout path must SIGKILL via forceStop() — a graceful stop() cannot
    // reap a not-yet-ready child — so stop() must NOT be used here.
    expect(mockState.startCalls).toBe(1);
    expect(mockState.forceStopCalls).toBe(1);
    expect(mockState.stopCalls).toBe(0);
  });

  it("still returns the static fallback when forceStop() rejects on the timeout path", async () => {
    mockState.startStalls = true;
    mockState.forceStopError = new Error("SIGKILL failed");

    const result = await discoverAvailableModels({ timeoutMs: 20 });

    // A failed reap must be swallowed: discovery still degrades gracefully.
    expect(result).toEqual({ models: KNOWN_MODELS, source: "static" });
    expect(mockState.forceStopCalls).toBe(1);
  });

  it("sanitizes an adversarial forceStop() failure diagnostic to a single safe line", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      mockState.startStalls = true;
      // Adversarial bytes: CRLF line-break injection, an ANSI CSI colour code, a
      // NUL, and a bare C1 CSI introducer (U+009B) — all forbidden in a TTY line.
      mockState.forceStopError = new Error("boom\r\ninjected: OK\u001b[31m\u0000\u009b2J");

      const result = await discoverAvailableModels({ timeoutMs: 20 });

      expect(result.source).toBe("static");
      expect(mockState.forceStopCalls).toBe(1);

      const cleanupLog = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .find((message) => message.includes("model discovery cleanup failed"));
      expect(cleanupLog).toBeDefined();
      expect(cleanupLog).not.toMatch(/[\r\n]/);
      expect(cleanupLog).not.toContain("\u001b");
      expect(cleanupLog).not.toContain("\u0000");
      expect(cleanupLog).not.toContain("\u009b");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
