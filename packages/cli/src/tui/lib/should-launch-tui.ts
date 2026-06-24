export interface LaunchStreams {
  readonly stdout?: { readonly isTTY?: boolean };
  readonly env?: NodeJS.ProcessEnv;
}

export function shouldLaunchTui(argv: readonly string[], streams: LaunchStreams = {}): boolean {
  const stdout = streams.stdout ?? process.stdout;
  const env = streams.env ?? process.env;
  const args = argv.slice(2);

  // `--no-tui` is an explicit per-invocation opt-out. It is a flag, not a
  // subcommand, so it must be checked before the subcommand guard below or it
  // would slip through and the default-on path would still launch the TUI.
  if (args.includes("--no-tui")) return false;
  // A non-flag positional (e.g. `convene`, `doctor`) means a subcommand was
  // requested; defer to the CLI rather than the full-screen UI.
  if (args.some((a) => !a.startsWith("-"))) return false;
  if (stdout.isTTY !== true) return false;
  if (env["CI"] !== undefined && env["CI"] !== "") return false;
  if (env["COUNCIL_NO_TUI"] !== undefined && env["COUNCIL_NO_TUI"] !== "") return false;
  // `COUNCIL_TUI=1` stays an explicit force for the transition; it is now
  // redundant with the default-on behavior but kept so the opt-in env var keeps
  // working and remains documented.
  if (env["COUNCIL_TUI"] === "1") return true;
  // Default ON: bare `council` on an interactive TTY launches the TUI.
  return true;
}
