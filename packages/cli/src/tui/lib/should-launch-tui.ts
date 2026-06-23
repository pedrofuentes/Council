export interface LaunchStreams {
  readonly stdout?: { readonly isTTY?: boolean };
  readonly env?: NodeJS.ProcessEnv;
}

export function shouldLaunchTui(argv: readonly string[], streams: LaunchStreams = {}): boolean {
  const stdout = streams.stdout ?? process.stdout;
  const env = streams.env ?? process.env;
  const hasSubcommand = argv.slice(2).some((a) => !a.startsWith("-"));
  if (hasSubcommand) return false;
  if (stdout.isTTY !== true) return false;
  if (env["CI"] !== undefined && env["CI"] !== "") return false;
  if (env["COUNCIL_NO_TUI"] !== undefined && env["COUNCIL_NO_TUI"] !== "") return false;
  return env["COUNCIL_TUI"] === "1";
}
