/**
 * @council/cli — Command-line interface entry point.
 *
 * Subcommands:
 *   - `convene`    run a panel debate on a topic (engine: mock | copilot)
 *   - `resume`     reopen a panel: show transcript or continue
 *   - `export`     export a panel transcript to markdown, json, or adr
 *   - `panels`     list panels in the local DB
 *   - `templates`  list built-in panel templates
 *   - `doctor`     diagnose Council setup
 */
import { Command } from "commander";

import packageJson from "../../package.json" with { type: "json" };

import { buildConveneCommand } from "../cli/commands/convene.js";
import { buildDoctorCommand } from "../cli/commands/doctor.js";
import { buildExportCommand } from "../cli/commands/export.js";
import { buildPanelsCommand } from "../cli/commands/panels.js";
import { buildResumeCommand } from "../cli/commands/resume.js";
import { buildTemplatesCommand } from "../cli/commands/templates.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("council")
    .description("Persistent AI expert panels for deliberation and decision-making")
    .version(packageJson.version);
  program.addCommand(buildConveneCommand());
  program.addCommand(buildResumeCommand());
  program.addCommand(buildExportCommand());
  program.addCommand(buildPanelsCommand());
  program.addCommand(buildTemplatesCommand());
  program.addCommand(buildDoctorCommand());
  return program;
}

// Only auto-parse when invoked as a script (not when imported by tests).
const isMainModule =
  import.meta.url === new URL(`file://${process.argv[1] ?? ""}`).href ||
  import.meta.url.endsWith("/bin/council.js");

if (isMainModule) {
  buildProgram().parse(process.argv);
}
