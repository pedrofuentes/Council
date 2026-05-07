/**
 * @council/cli — Command-line interface entry point.
 *
 * Subcommands are registered in Phase 1.10 (see ROADMAP.md).
 * This file currently provides only `--version` and `--help` so the
 * binary is functional after scaffolding.
 */
import { Command } from "commander";

import packageJson from "../../package.json" with { type: "json" };

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("council")
    .description("Persistent AI expert panels for deliberation and decision-making")
    .version(packageJson.version);
  return program;
}

// Only auto-parse when invoked as a script (not when imported by tests).
// import.meta.url and process.argv[1] differ in path style on Windows, so we
// compare normalized fileURL forms.
const isMainModule =
  import.meta.url === new URL(`file://${process.argv[1] ?? ""}`).href ||
  import.meta.url.endsWith("/bin/council.js");

if (isMainModule) {
  buildProgram().parse(process.argv);
}
