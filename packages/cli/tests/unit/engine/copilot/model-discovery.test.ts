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
  listModelsCalls: number;
  listModelsResults: MockModelInfo[];
  startError: Error | undefined;
  listModelsError: Error | undefined;
  stopError: Error | undefined;
}

const mockState: MockClientState = {
  startCalls: 0,
  stopCalls: 0,
  listModelsCalls: 0,
  listModelsResults: [],
  startError: undefined,
  listModelsError: undefined,
  stopError: undefined,
};

vi.mock("@github/copilot-sdk", () => {
  class MockCopilotClient {
    async start(): Promise<void> {
      mockState.startCalls += 1;
      if (mockState.startError) {
        throw mockState.startError;
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
  mockState.listModelsCalls = 0;
  mockState.listModelsResults = [];
  mockState.startError = undefined;
  mockState.listModelsError = undefined;
  mockState.stopError = undefined;
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
});
