/**
 * `council panels` — list all panels stored in Council's local DB.
 */
import * as path from "node:path";

import { Command } from "commander";

import { getCouncilHome } from "../../config/index.js";
import { createDatabase } from "../../memory/db.js";
import { PanelRepository } from "../../memory/repositories/panels.js";

import { defaultWriter, type Writer } from "./writer.js";

export interface PanelsCommandOptions {
  readonly format: "json" | "plain";
}

export function buildPanelsCommand(write: Writer = defaultWriter): Command {
  const cmd = new Command("panels");
  cmd
    .description("List all panels stored in Council")
    .option(
      "--format <kind>",
      "Output format: json (NDJSON) or plain (human-readable)",
      "plain",
    )
    .action(async (options: PanelsCommandOptions) => {
      const dbPath = path.join(getCouncilHome(), "council.db");
      const db = await createDatabase(dbPath);
      try {
        const repo = new PanelRepository(db);
        const panels = await repo.findAll();
        if (options.format === "json") {
          for (const panel of panels) {
            write(JSON.stringify(panel) + "\n");
          }
          return;
        }
        if (panels.length === 0) {
          write("No panels yet. Run `council convene \"<topic>\"` to create one.\n");
          return;
        }
        write(`${panels.length} panel${panels.length === 1 ? "" : "s"}:\n`);
        for (const panel of panels) {
          const topic = panel.topic ?? "(no topic)";
          write(`  • ${panel.name} — ${topic}\n`);
          write(`    id: ${panel.id}\n`);
          write(`    created: ${panel.createdAt}\n`);
        }
      } finally {
        await db.destroy();
      }
    });
  return cmd;
}
