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

const program = buildProgram();
program.parse(process.argv);
