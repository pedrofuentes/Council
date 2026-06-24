/**
 * `council ui` — launch the interactive terminal UI (TUI) explicitly.
 *
 * Bare `council` on an interactive TTY may auto-launch the TUI via the
 * launch gate (`shouldLaunchTui`), but `council ui` always launches it
 * regardless of that gate. This keeps the full-screen experience
 * discoverable and reachable even when the auto-launch default is off
 * (e.g. without `COUNCIL_TUI`, or after a `--no-tui` opt-out for bare
 * invocations).
 *
 * The TUI launcher is injectable so the command can be unit-tested
 * offline without rendering the Ink app.
 */
import { Command } from "commander";

import { launchTui } from "../../tui/index.js";

export interface UiCommandDeps {
  readonly launchTui?: () => Promise<void>;
}

export function buildUiCommand(deps: UiCommandDeps = {}): Command {
  const launch = deps.launchTui ?? launchTui;

  const cmd = new Command("ui");
  cmd.description("Launch the interactive terminal UI").action(async () => {
    await launch();
  });
  return cmd;
}
