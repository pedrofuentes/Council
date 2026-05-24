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

import { installSqliteExperimentalWarningFilter } from "./sqlite-warning-filter.js";

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
import {
  defaultErrorWriter,
  defaultWriter,
  setQuiet,
  type Writer,
} from "../cli/commands/writer.js";
import { selectModelInteractively } from "../cli/first-run-model-select.js";
import { loadConfigWithMeta } from "../config/index.js";

type WriteCallback = (error?: Error | null) => void;

interface EncodingWritable {
  write(
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | WriteCallback,
    cb?: WriteCallback,
  ): boolean;
}

const UTF8_OUTPUT_ENCODING: BufferEncoding = "utf8";
const wrappedOutputStreams = new WeakSet<EncodingWritable>();

function wrapUtf8Writes(stream: EncodingWritable): void {
  if (wrappedOutputStreams.has(stream)) {
    return;
  }

  const originalWrite = stream.write.bind(stream);
  stream.write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | WriteCallback,
    cb?: WriteCallback,
  ): boolean => {
    if (typeof chunk !== "string") {
      return originalWrite(chunk, encoding, cb);
    }

    if (typeof encoding === "string") {
      return originalWrite(chunk, encoding, cb);
    }

    if (typeof encoding === "function") {
      return originalWrite(chunk, UTF8_OUTPUT_ENCODING, encoding);
    }

    if (cb !== undefined) {
      return originalWrite(chunk, UTF8_OUTPUT_ENCODING, cb);
    }

    return originalWrite(chunk, UTF8_OUTPUT_ENCODING);
  };
  wrappedOutputStreams.add(stream);
}

export function configureOutputEncoding(
  platform: NodeJS.Platform = process.platform,
  stdout: EncodingWritable = process.stdout,
  stderr: EncodingWritable = process.stderr,
): void {
  if (platform !== "win32") {
    return;
  }

  wrapUtf8Writes(stdout);
  wrapUtf8Writes(stderr);
}

configureOutputEncoding();
installSqliteExperimentalWarningFilter();

// Command categories for grouped help output
const COMMAND_CATEGORIES = {
  "Getting Started": ["doctor", "config"],
  Deliberation: ["convene", "resume", "conclude"],
  Conversation: ["ask", "chat"],
  Library: ["expert", "panel", "templates"],
  Inspection: ["sessions", "memory", "export"],
} as const;

export interface FirstRunSetupOptions {
  readonly loadConfigWithMeta?: typeof loadConfigWithMeta;
  readonly selectModelInteractively?: typeof selectModelInteractively;
  readonly write?: Writer;
}

export interface BuildProgramOptions {
  readonly firstRunSetup?: FirstRunSetupOptions;
}

let hasRunFirstRunSetup = false;

export async function runFirstRunSetupOnce(
  options: FirstRunSetupOptions = {},
): Promise<void> {
  if (hasRunFirstRunSetup) {
    return;
  }

  hasRunFirstRunSetup = true;

  const loadConfig = options.loadConfigWithMeta ?? loadConfigWithMeta;
  const selectModel = options.selectModelInteractively ?? selectModelInteractively;
  const write = options.write ?? defaultWriter;
  const { isFirstRun } = await loadConfig();

  if (!isFirstRun) {
    return;
  }

  await selectModel({ write });
}

export function resetFirstRunSetupForTests(): void {
  hasRunFirstRunSetup = false;
}

// Commands that should NOT trigger the first-run model selection prompt.
// `doctor` is the diagnostic/recovery path and must remain usable when the
// model is unset or broken. `config` is the field-level configuration command
// (the recovery tool) and likewise must not be gated behind setup.
const FIRST_RUN_SETUP_SKIP_COMMANDS: ReadonlySet<string> = new Set(["doctor", "config"]);

function getTopLevelCommandName(actionCommand: Command): string {
  let current: Command = actionCommand;
  while (current.parent !== null && current.parent.parent !== null) {
    current = current.parent;
  }
  return current.name();
}

export function buildProgram(options: BuildProgramOptions = {}): Command {
  const program = new Command();
  program
    .name("council")
    .description("Persistent AI expert panels for deliberation and decision-making")
    .version(packageJson.version)
    .option("-q, --quiet", "Suppress informational stderr output")
    .showSuggestionAfterError(true);

  const firstRunSetupOptions = options.firstRunSetup;

  // Keep the default builder synchronous for tests and programmatic callers.
  // The CLI entrypoint opts into first-run setup explicitly when it parses asynchronously.
  if (firstRunSetupOptions !== undefined) {
    program.hook("preAction", async (thisCommand, actionCommand) => {
      const opts = thisCommand.optsWithGlobals() as { quiet?: boolean };
      setQuiet(opts.quiet === true);
      const topLevelName = getTopLevelCommandName(actionCommand);
      if (FIRST_RUN_SETUP_SKIP_COMMANDS.has(topLevelName)) {
        return;
      }
      await runFirstRunSetupOnce(firstRunSetupOptions);
    });
  } else {
    program.hook("preAction", (thisCommand) => {
      const opts = thisCommand.optsWithGlobals() as { quiet?: boolean };
      setQuiet(opts.quiet === true);
    });
  }

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
  buildProgram({ firstRunSetup: {} })
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      process.exitCode = handleCliError(err, defaultErrorWriter);
    });
}
