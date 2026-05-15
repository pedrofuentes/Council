/**
 * Top-level CLI error handler.
 *
 * Called from the entrypoint (`council.ts`) catch block. Converts
 * thrown errors into clean stderr output without stack traces.
 *
 * Returns the process exit code (always 1 for errors).
 */
import { CliUserError } from "./cli-user-error.js";

type Writer = (s: string) => void;

/**
 * Handle a thrown error from the CLI action layer.
 *
 * - `CliUserError` → silent (message was already written via `writeError`)
 * - Any other `Error` → write `Error: <message>` (no stack trace)
 * - Non-Error value → write stringified value
 */
export function handleCliError(err: unknown, writeError: Writer): number {
  if (err instanceof CliUserError) {
    // Message was already written to stderr by the command handler.
    return 1;
  }
  if (err instanceof Error) {
    writeError(`Error: ${err.message}\n`);
    return 1;
  }
  writeError(`Error: ${String(err)}\n`);
  return 1;
}
