/**
 * Broken-pipe (EPIPE) guard for the CLI entry point.
 *
 * When Council's stdout or stderr is piped to a reader that closes early —
 * `council … | head`, `council … | less` then `q`, `council … | grep -q …` —
 * the next write to the now-closed pipe fails with `EPIPE`. Node surfaces that
 * as an asynchronous `error` event on the stream; with no listener attached it
 * rethrows as an "Unhandled 'error' event", printing a stack trace and exiting
 * non-zero. That is noise, not a fault — the downstream reader simply stopped
 * listening.
 *
 * This guard attaches an `error` listener to each stream that turns *only* the
 * EPIPE case into a silent, clean `exit(0)` — the long-standing Unix convention
 * for a producer whose pipe closed. Any other stream error is rethrown so
 * genuine I/O failures keep their original diagnostics and exit status.
 * Installation is idempotent per stream.
 */

/** The `error`-event surface of a writable stream the guard attaches to. */
interface ErrorEmittingStream {
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** The `exit` surface the guard depends on (injected so it stays testable). */
interface ProcessExit {
  exit(code?: number): never;
}

const BROKEN_PIPE_CODE = "EPIPE";
const CLEAN_EXIT_CODE = 0;

// Track guarded streams so re-invoking the installer never stacks duplicate
// listeners on the same stdout/stderr instance.
const guardedStreams = new WeakSet<ErrorEmittingStream>();

function isBrokenPipeError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === BROKEN_PIPE_CODE;
}

/**
 * Attach the broken-pipe guard to the given streams (defaulting to the
 * process's stdout and stderr). Re-attaching to an already-guarded stream is a
 * no-op.
 */
export function installBrokenPipeGuard(
  streams: readonly ErrorEmittingStream[] = [process.stdout, process.stderr],
  exiter: ProcessExit = process,
): void {
  for (const stream of streams) {
    if (guardedStreams.has(stream)) {
      continue;
    }
    stream.on("error", (error: Error): void => {
      if (isBrokenPipeError(error)) {
        exiter.exit(CLEAN_EXIT_CODE);
      }
      throw error;
    });
    guardedStreams.add(stream);
  }
}
