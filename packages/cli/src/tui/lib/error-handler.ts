/**
 * Crash handler for the TUI root {@link ErrorBoundary}. A render-time crash must
 * still tear down the alternate screen *and* let the owning `finally` run its
 * cleanup (counter flush + `db.destroy()`). Calling `process.exit(1)` from
 * `onError` kills the event loop synchronously and skips that cleanup, so the
 * SQLite connection is left to close on process teardown — a race that can
 * abort the flush and leave the WAL unmerged.
 *
 * Instead we set a non-zero exit code (preserving the failure status) and signal
 * the Ink app to exit by unmounting, which resolves `waitUntilExit()` and lets
 * the cleanup run on the next tick before the process drains and exits.
 */
export interface TuiErrorHandlerDeps {
  /** Unmount the Ink instance so `waitUntilExit()` resolves and cleanup runs. */
  readonly signalExit: () => void;
  /** Records the failure status without tearing down the process. */
  readonly setExitCode?: (code: number) => void;
  /** Surfaces the error to the user. */
  readonly log?: (error: Error) => void;
  /** Hard process exit — injected only so tests can assert it is NOT used. */
  readonly hardExit?: (code: number) => void;
}

/**
 * Build the `onError` handler for the TUI root ErrorBoundary. Idempotent: only
 * the first crash signals exit, so cleanup runs once even if React reports
 * multiple errors during unmount.
 */
export function createTuiErrorHandler(deps: TuiErrorHandlerDeps): (error: Error) => void {
  const setExitCode = deps.setExitCode ?? ((code: number) => (process.exitCode = code));
  const log = deps.log ?? ((error: Error) => console.error("Council TUI error:", error));
  let exited = false;

  return (error: Error): void => {
    log(error);
    setExitCode(1);
    if (exited) {
      return;
    }
    exited = true;
    // Best-effort: a failed unmount must not throw out of the React error path.
    try {
      deps.signalExit();
    } catch {
      /* swallow — cleanup still runs as the process drains */
    }
  };
}
