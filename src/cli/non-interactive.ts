/**
 * Detect non-interactive (non-TTY) environments for CI/automation.
 *
 * Used by commands that have confirmation prompts (e.g. convene auto-compose)
 * to fail closed in non-interactive mode — requiring explicit --yes.
 */

/**
 * Returns true when stdin is not a TTY — e.g. piped input, CI runners,
 * or redirected file descriptors.
 */
export function isNonInteractive(): boolean {
  return !process.stdin.isTTY;
}
