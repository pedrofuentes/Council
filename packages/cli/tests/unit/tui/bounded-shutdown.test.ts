import { describe, expect, it, vi } from "vitest";

import { runTuiWithBoundedShutdown } from "../../../src/tui/index.js";

describe("runTuiWithBoundedShutdown", () => {
  it("runs the session driver then the shutdown to completion on a normal exit", async () => {
    const order: string[] = [];
    const run = vi.fn(async () => {
      order.push("run");
    });
    const shutdown = vi.fn(async () => {
      order.push("shutdown");
    });

    await expect(runTuiWithBoundedShutdown(run, shutdown, 5_000)).resolves.toBeUndefined();

    // Shutdown runs exactly once, after the session driver.
    expect(order).toEqual(["run", "shutdown"]);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("re-throws a synchronous startup crash after running the shutdown", async () => {
    const crash = new Error("startup boom");
    const run = vi.fn(async () => {
      throw crash;
    });
    const shutdown = vi.fn(async () => undefined);

    // The exact crash is re-thrown (not swallowed, not replaced) …
    await expect(runTuiWithBoundedShutdown(run, shutdown, 5_000)).rejects.toBe(crash);
    // … and cleanup still ran on the crash path.
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("bounds a hanging shutdown on a startup crash so the crash still surfaces", async () => {
    vi.useFakeTimers();
    try {
      const crash = new Error("startup boom");
      const run = vi.fn(async () => {
        throw crash;
      });
      // Shutdown hangs forever — without the timeout this would wedge the
      // process and swallow the crash entirely.
      const shutdown = vi.fn(() => new Promise<void>(() => undefined));

      const settled = runTuiWithBoundedShutdown(run, shutdown, 5_000);
      const outcome = vi.fn();
      // Observe settlement without leaving an unhandled rejection.
      settled.then(outcome, outcome);

      // Flush microtasks so the rejected run() reaches the crash branch and the
      // (hanging) teardown actually starts before we probe the timeout bound.
      await vi.advanceTimersByTimeAsync(0);
      expect(shutdown).toHaveBeenCalledTimes(1);

      // Just before the budget elapses the crash has NOT surfaced yet — the
      // bound is the timeout, not an immediate abandonment of cleanup.
      await vi.advanceTimersByTimeAsync(4_999);
      expect(outcome).not.toHaveBeenCalled();

      // Once the budget fires, the bounded wait ends and the crash re-throws.
      await vi.advanceTimersByTimeAsync(1);
      await expect(settled).rejects.toBe(crash);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT bound the shutdown on a normal exit (a full teardown may outlast the crash budget)", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => undefined);
      let finishShutdown: () => void = () => undefined;
      const shutdown = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishShutdown = resolve;
          }),
      );

      const settled = runTuiWithBoundedShutdown(run, shutdown, 5_000);
      const outcome = vi.fn();
      settled.then(outcome, outcome);

      // Advance far beyond the crash budget: a normal-exit teardown is
      // unbounded, so it must still be pending (the crash timeout must not cut
      // a healthy WAL merge short).
      await vi.advanceTimersByTimeAsync(60_000);
      expect(outcome).not.toHaveBeenCalled();

      // It settles only when the real teardown actually finishes.
      finishShutdown();
      await expect(settled).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains a shutdown failure on the crash path so it cannot mask the crash", async () => {
    const crash = new Error("startup boom");
    const run = vi.fn(async () => {
      throw crash;
    });
    const shutdown = vi.fn(async () => {
      throw new Error("db.destroy failed");
    });

    // The ORIGINAL crash surfaces — the teardown failure is contained, not
    // rethrown in its place.
    await expect(runTuiWithBoundedShutdown(run, shutdown, 5_000)).rejects.toBe(crash);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
