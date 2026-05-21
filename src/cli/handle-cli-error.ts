/**
 * Top-level CLI error handler.
 *
 * Called from the entrypoint (`council.ts`) catch block. Converts
 * thrown errors into clean stderr output without stack traces.
 *
 * Returns a semantic process exit code (see `exit-codes.ts`).
 */
import { CliUserError } from "./cli-user-error.js";
import { EXIT_INTERNAL_ERROR, EXIT_USER_ERROR, exitCodeForEngineError } from "./exit-codes.js";

type Writer = (s: string) => void;

/**
 * Handle a thrown error from the CLI action layer.
 *
 * - `CliUserError` → silent (message was already written via `writeError`);
 *   uses `exitCode` if set, otherwise defaults to EXIT_USER_ERROR (1).
 * - Engine-like errors (with a `code` property) → map via `exitCodeForEngineError`
 * - Any other `Error` → write `Error: <message>` (no stack trace), EXIT_INTERNAL_ERROR (4)
 * - Non-Error value → write stringified value, EXIT_INTERNAL_ERROR (4)
 */
export function handleCliError(err: unknown, writeError: Writer): number {
  if (err instanceof CliUserError) {
    return err.exitCode ?? EXIT_USER_ERROR;
  }
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code) {
      writeError(`Error: ${err.message}\n`);
      return exitCodeForEngineError(code);
    }
    writeError(`Error: ${err.message}\n`);
    return EXIT_INTERNAL_ERROR;
  }
  writeError(`Error: ${String(err)}\n`);
  return EXIT_INTERNAL_ERROR;
}
