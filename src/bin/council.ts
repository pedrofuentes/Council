/**
 * @council/cli — Command-line interface entry point.
 *
 * Subcommands:
 *   - `convene`    run a panel debate on a topic (engine: mock | copilot)
 *   - `ask`        ask one expert from an existing panel a single question
 *   - `resume`     reopen a panel: show transcript or continue
 *   - `export`     export a panel transcript to markdown, json, or adr
 *   - `sessions`   list debate sessions in the local DB (alias: `panels`)
 *   - `expert`     manage the expert library (create/list/inspect/edit/delete)
 *   - `templates`  list built-in panel templates
 *   - `memory`     inspect and curate Council's local SQLite state
 *   - `doctor`     diagnose Council setup
 */
import { Command } from "commander";

import packageJson from "../../package.json" with { type: "json" };

import { buildAskCommand } from "../cli/commands/ask.js";
import { buildChatCommand } from "../cli/commands/chat.js";
import { buildConcludeCommand } from "../cli/commands/conclude.js";
import { buildConveneCommand } from "../cli/commands/convene.js";
import { buildDoctorCommand } from "../cli/commands/doctor.js";
import { buildExpertCommand } from "../cli/commands/expert.js";
import { buildExportCommand } from "../cli/commands/export.js";
import { buildMemoryCommand } from "../cli/commands/memory.js";
import { buildPanelCommand } from "../cli/commands/panel.js";
import { buildResumeCommand } from "../cli/commands/resume.js";
import { buildSessionsCommand } from "../cli/commands/sessions.js";
import { buildTemplatesCommand } from "../cli/commands/templates.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("council")
    .description("Persistent AI expert panels for deliberation and decision-making")
    .version(packageJson.version);
  program.addCommand(buildConveneCommand());
  program.addCommand(buildAskCommand());
  program.addCommand(buildChatCommand());
  program.addCommand(buildResumeCommand());
  program.addCommand(buildConcludeCommand());
  program.addCommand(buildExportCommand());
  program.addCommand(buildSessionsCommand().alias("panels"));
  program.addCommand(buildPanelCommand());
  program.addCommand(buildExpertCommand());
  program.addCommand(buildTemplatesCommand());
  program.addCommand(buildMemoryCommand());
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
