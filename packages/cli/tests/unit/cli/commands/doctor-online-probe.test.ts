/**
 * Tests for the default `council doctor` online probe timeout/cancellation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { probeCopilotModel } from "../../../../src/cli/commands/doctor-online-probe.js";

interface FakeEngine {
  start(): Promise<void>;
  addExpert(): Promise<void>;
  stop(): Promise<void>;
}

describe("probeCopilotModel timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds a hung engine.start with a timeout and reports it", async () => {
    const stop = vi.fn(async () => {});
    const engine: FakeEngine = {
      start: () => new Promise<void>(() => {}),
      addExpert: async () => {},
      stop,
    };

    const promise = probeCopilotModel("claude-sonnet-4.5", {
      timeoutMs: 50,
      createEngine: () => engine,
    });

    await vi.advanceTimersByTimeAsync(60);
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("timed out");
    expect(result.detail).toContain("50");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("returns ok when the engine resolves before the timeout", async () => {
    const engine: FakeEngine = {
      start: async () => {},
      addExpert: async () => {},
      stop: async () => {},
    };

    const result = await probeCopilotModel("claude-sonnet-4.5", {
      timeoutMs: 1000,
      createEngine: () => engine,
    });

    expect(result.ok).toBe(true);
  });
});
