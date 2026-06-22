// packages/cli/src/tui/lib/interactive.ts

export interface InteractiveStreams {
  readonly stdout?: { readonly isTTY?: boolean };
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * True only when a full-screen TUI should launch: stdout is a TTY, the process
 * is not in CI, and the user has not opted out via COUNCIL_NO_TUI. Defaults to
 * the live process streams; injectable for tests.
 */
export function isInteractive(streams: InteractiveStreams = {}): boolean {
  const stdout = streams.stdout ?? process.stdout;
  const env = streams.env ?? process.env;
  if (stdout.isTTY !== true) return false;
  if (env.CI !== undefined && env.CI !== "") return false;
  if (env.COUNCIL_NO_TUI !== undefined && env.COUNCIL_NO_TUI !== "") return false;
  return true;
}
