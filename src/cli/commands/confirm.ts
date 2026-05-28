/**
 * Shared confirmation prompt abstraction.
 *
 * Provides an injectable {@link ConfirmProvider} interface so commands
 * can gate actions behind user consent while remaining testable in
 * non-TTY environments (tests inject a mock, production uses readline).
 */

/**
 * Prompts the user to confirm an action and resolves with their choice.
 */
export interface ConfirmProvider {
  confirm(message: string): Promise<boolean>;
}

/**
 * Default {@link ConfirmProvider} backed by Node's `readline`. Reads
 * a single line from stdin and resolves true only when the user typed
 * `y` or `yes` (case-insensitive). Anything else — including an empty
 * line or EOF — resolves false (the safer default for a prompt the user
 * may have missed entirely).
 */
export function createReadlineConfirmProvider(): ConfirmProvider {
  return {
    async confirm(message: string): Promise<boolean> {
      // When stdin is not a TTY (piped input, detached terminal, CI),
      // `readline.question` cannot prompt the user — and if stdin has
      // already closed (EOF), its callback never fires. The previous
      // implementation hung; once Node's event loop drained, the
      // process exited silently with status 0, masking the cancellation
      // (#f25). Detect non-interactive stdin up-front and resolve to
      // the safe default (false) so callers can surface a clear
      // "Aborted" message and exit non-zero.
      if (process.stdin.isTTY !== true) {
        // Echo the prompt to stderr so the user sees what was skipped.
        process.stderr.write(message);
        process.stderr.write("\n");
        return false;
      }
      const readline = await import("node:readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const answer = await new Promise<string>((resolve) => {
          // Belt-and-braces: if the TTY closes mid-prompt (e.g. the
          // user hits Ctrl-D), `question`'s callback is not invoked.
          // Resolving on `close` keeps the promise from hanging.
          rl.once("close", () => resolve(""));
          rl.question(message, (a) => resolve(a));
        });
        const normalized = answer.trim().toLowerCase();
        return normalized === "y" || normalized === "yes";
      } finally {
        rl.close();
      }
    },
  };
}
