import { afterEach, describe, expect, it, vi } from "vitest";

import { createTuiErrorHandler } from "../../../src/tui/lib/error-handler.js";

describe("createTuiErrorHandler", () => {
  afterEach(() => {
    // Restore the real `process.exit` spy so it can never leak into another
    // test in this file (a spy on a global is a #1900-class contamination risk).
    vi.restoreAllMocks();
  });

  it("logs the error, sets a non-zero exit code, and signals exit instead of killing the process", () => {
    // Spy the REAL `process.exit`. The whole point of the graceful handler is
    // that it must NOT call `process.exit`, which kills the event loop
    // synchronously and skips the owning `finally { db.destroy() }` cleanup
    // (#1588). Asserting the ABSENCE of a call against the true global — rather
    // than an injected mock the handler never wired up — is what makes this a
    // discriminating regression guard: reintroducing `process.exit(1)` in the
    // guarded path now fails this test. The mock is a no-op so the test process
    // survives if a regression ever does call it.
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number): never => undefined as never);
    const signalExit = vi.fn();
    const log = vi.fn();
    const setExitCode = vi.fn();

    const onError = createTuiErrorHandler({ signalExit, log, setExitCode });
    const boom = new Error("kaboom");
    onError(boom);

    // Logged for the user.
    expect(log).toHaveBeenCalledWith(boom);
    // Preserves the failure status without bypassing cleanup.
    expect(setExitCode).toHaveBeenCalledWith(1);
    // Unmount so waitUntilExit resolves and the `finally { db.destroy() }` runs.
    expect(signalExit).toHaveBeenCalledTimes(1);
    // The bug (#1588): process.exit(1) skipped the cleanup — it must NOT run.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("signals exit only once even when multiple errors arrive", () => {
    const signalExit = vi.fn();
    const onError = createTuiErrorHandler({
      signalExit,
      log: vi.fn(),
      setExitCode: vi.fn(),
    });

    onError(new Error("first"));
    onError(new Error("second"));

    expect(signalExit).toHaveBeenCalledTimes(1);
  });

  it("logs a throwing signalExit (sanitized) instead of swallowing it, and still surfaces the exit code", () => {
    const setExitCode = vi.fn();
    const log = vi.fn();
    // A crafted unmount failure whose message carries terminal control
    // sequences (an ANSI CSI colour code + CRLF) that would corrupt the
    // alternate screen if logged raw.
    const onError = createTuiErrorHandler({
      signalExit: () => {
        throw new Error("teardown \u001b[31mboom\u001b[0m\r\nsecond");
      },
      log,
      setExitCode,
    });

    // A failed unmount must not throw out of the React error path …
    expect(() => onError(new Error("boom"))).not.toThrow();
    // … and the failure status is still recorded.
    expect(setExitCode).toHaveBeenCalledWith(1);

    // The unmount failure is surfaced (no longer silently swallowed): the
    // render error is logged first, then the throwing signalExit.
    expect(log).toHaveBeenCalledTimes(2);
    const loggedUnmountFailure = log.mock.calls[1]?.[0];
    expect(loggedUnmountFailure).toBeInstanceOf(Error);
    const message = (loggedUnmountFailure as Error).message;
    expect(message).toContain("crash handling");
    // Sanitized to a single line with the control sequences stripped: the
    // colour codes are gone and the CRLF is collapsed to one space.
    expect(message).toContain("teardown boom second");
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("\r");
    expect(message).not.toContain("\n");
  });
});
