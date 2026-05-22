/**
 * @council/cli — Command-line interface entry point.
 *
 * Subcommands (see `buildProgram()` below for the canonical list):
 *   - `convene`    run a panel debate on a topic (engine: mock | copilot)
 *   - `ask`        ask one expert from an existing panel a single question
 *   - `chat`       open a persistent conversational REPL with an expert or panel
 *   - `resume`     reopen a panel: show transcript or continue
 *   - `conclude`   synthesize a panel's latest debate into a decision framework
 *   - `export`     export a panel transcript to markdown, json, or adr
 *   - `sessions`   list debate sessions in the local DB
 *   - `panel`      manage the panel library (create/list/inspect/edit/docs)
 *   - `expert`     manage the expert library (create/list/inspect/edit/delete/docs/train)
 *   - `templates`  list built-in panel templates
 *   - `memory`     inspect and curate Council's local SQLite state
 *   - `doctor`     diagnose Council setup
 */
import { Command } from "commander";

import packageJson from "../../package.json" with { type: "json" };

import { buildAskCommand } from "../cli/commands/ask.js";
import { buildChatCommand } from "../cli/commands/chat.js";
import { buildConcludeCommand } from "../cli/commands/conclude.js";
import { buildConfigCommand } from "../cli/commands/config.js";
import { buildConveneCommand } from "../cli/commands/convene.js";
import { buildDoctorCommand } from "../cli/commands/doctor.js";
import { buildExpertCommand } from "../cli/commands/expert.js";
import { buildExportCommand } from "../cli/commands/export.js";
import { buildMemoryCommand } from "../cli/commands/memory.js";
import { buildPanelCommand } from "../cli/commands/panel.js";
import { buildResumeCommand } from "../cli/commands/resume.js";
import { buildSessionsCommand } from "../cli/commands/sessions.js";
import { buildTemplatesCommand } from "../cli/commands/templates.js";

import { handleCliError } from "../cli/handle-cli-error.js";
import { setQuiet } from "../cli/commands/writer.js";

// Command categories for grouped help output
const COMMAND_CATEGORIES = {
  "Getting Started": ["doctor", "config"],
  Deliberation: ["convene", "resume", "conclude"],
  Conversation: ["ask", "chat"],
  Library: ["expert", "panel", "templates"],
  Inspection: ["sessions", "memory", "export"],
} as const;

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("council")
    .description("Persistent AI expert panels for deliberation and decision-making")
    .version(packageJson.version)
    .option("-q, --quiet", "Suppress informational stderr output")
    .showSuggestionAfterError(true);

  // Wire --quiet: suppress informational stderr before any subcommand action runs
  program.hook("preAction", (thisCommand) => {
    const opts = thisCommand.optsWithGlobals() as { quiet?: boolean };
    setQuiet(opts.quiet === true);
  });

  // Register commands in category order
  program.addCommand(buildDoctorCommand());
  program.addCommand(buildConfigCommand());
  program.addCommand(buildConveneCommand());
  program.addCommand(buildResumeCommand());
  program.addCommand(buildConcludeCommand());
  program.addCommand(buildAskCommand());
  program.addCommand(buildChatCommand());
  program.addCommand(buildExpertCommand());
  program.addCommand(buildPanelCommand());
  program.addCommand(buildTemplatesCommand());
  program.addCommand(buildSessionsCommand());
  program.addCommand(buildMemoryCommand());
  program.addCommand(buildExportCommand());

  // Custom help formatter with command grouping
  program.configureHelp({
    formatHelp: (cmd, helper) => {
      const termWidth = helper.padWidth(cmd, helper);

      const sections: string[] = [];

      // Usage
      sections.push(`Usage: ${helper.commandUsage(cmd)}`);
      sections.push("");

      // Description
      sections.push(helper.commandDescription(cmd));

      // Options
      if (cmd.options.length > 0) {
        sections.push("");
        sections.push("Options:");
        cmd.options.forEach((option) => {
          sections.push(
            `  ${helper.optionTerm(option).padEnd(termWidth)}  ${helper.optionDescription(option)}`,
          );
        });
      }

      // Commands - grouped by category
      sections.push("");
      sections.push("Commands:");
      sections.push("");

      for (const [category, commandNames] of Object.entries(COMMAND_CATEGORIES)) {
        sections.push(`${category}:`);
        for (const cmdName of commandNames) {
          const subCmd = cmd.commands.find((c) => c.name() === cmdName);
          if (subCmd) {
            sections.push(
              `  ${helper.subcommandTerm(subCmd).padEnd(termWidth)}  ${helper.subcommandDescription(subCmd)}`,
            );
          }
        }
        sections.push("");
      }

      // Getting-started hint
      sections.push("New to Council? Start with: council doctor");

      return sections.join("\n");
    },
  });

  return program;
}

// Only auto-parse when invoked as a script (not when imported by tests).
const isMainModule =
  import.meta.url === new URL(`file://${process.argv[1] ?? ""}`).href ||
  import.meta.url.endsWith("/bin/council.js");

if (isMainModule) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      process.exitCode = handleCliError(err, (s) => process.stderr.write(s));
    });
}
