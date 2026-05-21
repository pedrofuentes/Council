/**
 * `council templates` — list built-in panel templates that ship with Council.
 *
 * Templates live as YAML files in the `panels/` directory at the package
 * root (per ROADMAP §1.11 / PR #36). This command lists their names so
 * users know what `--template <name>` arguments are valid.
 */
import { Command } from "commander";

import { listTemplates } from "../../core/template-loader.js";

import { defaultWriter, type Writer } from "./writer.js";

export function buildTemplatesCommand(write: Writer = defaultWriter): Command {
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
  return cmd;
}
