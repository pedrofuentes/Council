/**
 * @council-ai/cli — Command-line interface entry point.
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
// SQLite ExperimentalWarning filter — MUST be the first import in this
// entry point. Importing this module installs `process.emitWarning` patch
// as a side effect, before any sibling import can transitively load
// `node:sqlite` (Council's persistence backend) and emit Node's
// `SQLite is an experimental feature` warning. See F02 in T12.
import "./sqlite-warning-filter.js";

import * as childProcess from "node:child_process";

import { Command } from "commander";

import packageJson from "../../package.json" with { type: "json" };

import { installSqliteExperimentalWarningFilter } from "./sqlite-warning-filter.js";

import { buildAskCommand } from "../cli/commands/ask.js";
import { buildChatCommand } from "../cli/commands/chat.js";
import { buildConcludeCommand } from "../cli/commands/conclude.js";
import { buildConfigCommand } from "../cli/commands/config.js";
import { buildConveneCommand } from "../cli/commands/convene.js";
import { buildDemoCommand } from "../cli/commands/demo.js";
import { buildDocsCommand } from "../cli/commands/docs.js";
import { buildDoctorCommand } from "../cli/commands/doctor.js";
import { buildExpertCommand } from "../cli/commands/expert.js";
import { buildExportCommand } from "../cli/commands/export.js";
import { buildMemoryCommand } from "../cli/commands/memory.js";
import { buildModelsCommand } from "../cli/commands/models.js";
import { buildPanelCommand } from "../cli/commands/panel.js";
import { buildResumeCommand } from "../cli/commands/resume.js";
import { buildSessionsCommand } from "../cli/commands/sessions.js";
import { buildTelemetryCommand } from "../cli/commands/telemetry.js";
import { buildTemplatesCommand } from "../cli/commands/templates.js";
import { buildUpdateCommand } from "../cli/commands/update.js";

import { handleCliError } from "../cli/handle-cli-error.js";
import {
  defaultErrorWriter,
  defaultWriter,
  isQuiet,
  setQuiet,
  type Writer,
} from "../cli/commands/writer.js";
import { selectModelInteractively } from "../cli/first-run-model-select.js";
import { renderBanner } from "../cli/renderers/banner.js";
import { loadConfigWithMeta } from "../config/index.js";
import { maybeNotifyUpdate } from "../core/version/index.js";

type WriteCallback = (error?: Error | null) => void;

interface EncodingWritable {
  readonly isTTY?: boolean;
  write(
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | WriteCallback,
    cb?: WriteCallback,
  ): boolean;
}

const UTF8_OUTPUT_ENCODING: BufferEncoding = "utf8";
const WINDOWS_UTF8_CODE_PAGE = "65001";
const WINDOWS_CODE_PAGE_COMMAND = "chcp.com";
const configuredConsoleCodePageStreams = new WeakSet<EncodingWritable>();
const wrappedOutputStreams = new WeakSet<EncodingWritable>();

function configureWindowsConsoleCodePage(stream: EncodingWritable): void {
  if (!stream.isTTY || configuredConsoleCodePageStreams.has(stream)) {
    return;
  }

  try {
    childProcess.execFileSync(WINDOWS_CODE_PAGE_COMMAND, [WINDOWS_UTF8_CODE_PAGE], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    // Best effort: keep CLI output flowing even if the host console rejects chcp.
  } finally {
    configuredConsoleCodePageStreams.add(stream);
  }
}

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

  const consoleStream = stdout.isTTY ? stdout : stderr;

  if (consoleStream.isTTY) {
    configureWindowsConsoleCodePage(consoleStream);
  }

  if (stdout.isTTY) {
    wrapUtf8Writes(stdout);
  }

  if (stderr.isTTY) {
    wrapUtf8Writes(stderr);
  }
}

configureOutputEncoding();
installSqliteExperimentalWarningFilter();

// Command categories for grouped help output
const COMMAND_CATEGORIES = {
  "Getting Started": ["doctor", "demo", "config", "telemetry", "docs", "update"],
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

export async function runFirstRunSetupOnce(options: FirstRunSetupOptions = {}): Promise<void> {
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
// `demo` is a zero-setup, offline showcase — it must run on a brand-new
// machine with no model configured, so it can never be gated behind setup.
// `doctor` is the diagnostic/recovery path and must remain usable when the
// model is unset or broken. `config` is the field-level configuration command
// (the recovery tool) and likewise must not be gated behind setup. `telemetry`
// is a configuration management command and must work without model setup.
const FIRST_RUN_SETUP_SKIP_COMMANDS: ReadonlySet<string> = new Set([
  "demo",
  "doctor",
  "config",
  "telemetry",
]);

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
    .showSuggestionAfterError(true)
    .showHelpAfterError("(run `council <command> --help` for usage)");

  // Show the wordmark banner above root help only (bare `council` / `council
  // --help`), and only on an interactive stdout. Commander's "before" position
  // (unlike "beforeAll") does not propagate to subcommand help, so
  // `council <cmd> --help` stays banner-free. `--version` emits no help and is
  // therefore unaffected.
  program.addHelpText("before", () =>
    process.stdout.isTTY === true ? `${renderBanner({ version: packageJson.version })}\n\n` : "",
  );

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
  program.addCommand(buildDemoCommand());
  program.addCommand(buildConfigCommand());
  program.addCommand(buildTelemetryCommand());
  program.addCommand(buildDocsCommand());
  program.addCommand(buildUpdateCommand());
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
  program.addCommand(buildModelsCommand());

  // Apply the same "(run --help for usage)" hint to every (sub)command so that
  // errors like "missing required argument" point users at help. Commander's
  // showHelpAfterError() is per-command and does not propagate to children.
  const helpHint = "(run `council <command> --help` for usage)";
  const applyHelpHintRecursively = (cmd: Command): void => {
    cmd.showHelpAfterError(helpHint);
    cmd.commands.forEach(applyHelpHintRecursively);
  };
  applyHelpHintRecursively(program);

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
  const runCli = async (): Promise<void> => {
    try {
      await buildProgram({ firstRunSetup: {} }).parseAsync(process.argv);
    } catch (err: unknown) {
      process.exitCode = handleCliError(err, defaultErrorWriter);
    } finally {
      // Print a throttled "update available" notice at the END of a run (both
      // success and error paths). Gated on a stderr TTY and --quiet; the notice
      // goes to stderr only so stdout/JSON output stays clean. The background
      // registry refresh is fired and forgotten (its abort timer is unref'd)
      // so it never changes the exit code, throws, or delays exit.
      const quiet = isQuiet() || process.argv.includes("-q") || process.argv.includes("--quiet");
      await maybeNotifyUpdate({
        currentVersion: packageJson.version,
        isTTY: process.stderr.isTTY === true,
        quiet,
      });
    }
  };

  void runCli();
}
