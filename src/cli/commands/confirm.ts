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
      const readline = await import("node:readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const answer = await new Promise<string>((resolve) => {
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
