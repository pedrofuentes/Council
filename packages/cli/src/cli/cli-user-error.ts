/**
 * Lightweight error class for user-facing CLI failures.
 *
 * When a command detects a user error (missing resource, invalid input,
 * etc.) it writes a human-readable message via `writeError()` and then
 * throws a `CliUserError` so the top-level handler in `council.ts`
 * knows to exit non-zero without dumping a stack trace.
 *
 * Tests call `cmd.parseAsync()` directly and assert on the thrown error,
 * bypassing the top-level handler entirely.
 */
export class CliUserError extends Error {
  /** Optional semantic exit code override (see `exit-codes.ts`). */
  exitCode?: number;

  constructor(message: string) {
    super(message);
    this.name = "CliUserError";
  }
}
