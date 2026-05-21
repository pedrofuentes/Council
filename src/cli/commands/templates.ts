/**
 * `council templates` — list built-in panel templates that ship with Council.
 *
 * Templates live as YAML files in the `panels/` directory at the package
 * root (per ROADMAP §1.11 / PR #36). This command lists their names so
 * users know what `--template <name>` arguments are valid.
 *
 * Subcommands:
 *   - `council templates inspect <name>` — show template detail
 */
import { Command } from "commander";

import { listTemplates, loadTemplate } from "../../core/template-loader.js";
import { PanelNotFoundError } from "../../core/template-loader.js";
import { CliUserError } from "../cli-user-error.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";

export function buildTemplatesCommand(
  write: Writer = defaultWriter,
  writeError: Writer = defaultErrorWriter,
): Command {
  const cmd = new Command("templates");
  cmd.description("List built-in panel templates").action(async () => {
    const names = await listTemplates();
    if (names.length === 0) {
      write("No templates found.\n");
      return;
    }
    write("Built-in templates:\n");
    for (const name of names) {
      write(`  • ${name}\n`);
    }
    write("\nUse with: council convene --template <name>\n");
    write("\x1b[2mNext: council convene --template <name>\x1b[0m\n");
  });

  cmd.addCommand(buildInspectCommand(write, writeError));

  return cmd;
}

function buildInspectCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("inspect");
  cmd
    .description("Show detailed information about a template")
    .argument("<name>", "Template name to inspect")
    .action(async (name: string) => {
      let panel;
      try {
        panel = await loadTemplate(name);
      } catch (err: unknown) {
        if (err instanceof PanelNotFoundError) {
          writeError(`Error: ${err.message}\n`);
          throw new CliUserError(err.message);
        }
        throw err;
      }

      write(`\n# ${panel.name}\n`);
      if (panel.description) {
        write(`\nDescription:\n  ${panel.description.trim()}\n`);
      }

      const mode = panel.defaults?.mode ?? "freeform";
      const maxRounds = panel.defaults?.maxRounds;
      write(`\nDefaults:\n`);
      write(`  Mode: ${mode}\n`);
      if (maxRounds !== undefined) {
        write(`  Max rounds: ${maxRounds}\n`);
      }

      write(`\nExperts (${panel.experts.length}):\n`);
      for (const expert of panel.experts) {
        write(`  • ${expert.slug} — ${expert.displayName}\n`);
        write(`    Role: ${expert.role}\n`);
      }

      write(`\nUsage: council convene --template ${name}\n`);
    });
  return cmd;
}
