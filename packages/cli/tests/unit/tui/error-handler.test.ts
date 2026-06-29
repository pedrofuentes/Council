import { describe, expect, it, vi } from "vitest";

import { createTuiErrorHandler } from "../../../src/tui/lib/error-handler.js";

describe("createTuiErrorHandler", () => {
  it("logs the error, sets a non-zero exit code, and signals exit instead of killing the process", () => {
    const signalExit = vi.fn();
    const log = vi.fn();
    const setExitCode = vi.fn();
    const hardExit = vi.fn();

    const onError = createTuiErrorHandler({ signalExit, log, setExitCode, hardExit });
    const boom = new Error("kaboom");
    onError(boom);

    // Logged for the user.
    expect(log).toHaveBeenCalledWith(boom);
    // Preserves the failure status without bypassing cleanup.
    expect(setExitCode).toHaveBeenCalledWith(1);
    // Unmount so waitUntilExit resolves and the `finally { db.destroy() }` runs.
    expect(signalExit).toHaveBeenCalledTimes(1);
    // The bug: process.exit(1) skipped the cleanup — it must NOT be called.
    expect(hardExit).not.toHaveBeenCalled();
  });

  it("signals exit only once even when multiple errors arrive", () => {
    const signalExit = vi.fn();
    const onError = createTuiErrorHandler({
      signalExit,
      log: vi.fn(),
      setExitCode: vi.fn(),
      hardExit: vi.fn(),
    });

    onError(new Error("first"));
    onError(new Error("second"));

    expect(signalExit).toHaveBeenCalledTimes(1);
  });

  it("survives a throwing signalExit so cleanup still gets the chance to run", () => {
    const setExitCode = vi.fn();
    const onError = createTuiErrorHandler({
      signalExit: () => {
        throw new Error("unmount failed");
      },
      log: vi.fn(),
      setExitCode,
      hardExit: vi.fn(),
    });

    expect(() => onError(new Error("boom"))).not.toThrow();
    expect(setExitCode).toHaveBeenCalledWith(1);
  });
});
