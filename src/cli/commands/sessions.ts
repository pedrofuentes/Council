/**
 * `council sessions` — list all debate session records stored in Council's
 * local DB. (Renamed from `council panels` for clarity vs. `council panel`,
 * which manages the panel YAML library. The DB table is still `panels`.)
 */
import * as path from "node:path";

import { Command } from "commander";

import { getCouncilHome } from "../../config/index.js";
import { createDatabase } from "../../memory/db.js";
import { PanelRepository } from "../../memory/repositories/panels.js";

import { defaultWriter, type Writer } from "./writer.js";

export interface SessionsCommandOptions {
  readonly format: "json" | "plain";
}

export function buildSessionsCommand(write: Writer = defaultWriter): Command {
  const cmd = new Command("sessions");
  cmd
    .description("List all debate sessions stored in Council")
    .option(
      "--format <kind>",
      "Output format: json (NDJSON) or plain (human-readable)",
      "plain",
    )
    .action(async (options: SessionsCommandOptions) => {
      const dbPath = path.join(getCouncilHome(), "council.db");
      const db = await createDatabase(dbPath);
      try {
        const repo = new PanelRepository(db);
        const sessions = await repo.findAll();
        if (options.format === "json") {
          for (const session of sessions) {
            write(JSON.stringify(session) + "\n");
          }
          return;
        }
        if (sessions.length === 0) {
          write("No sessions yet. Run `council convene \"<topic>\"` to create one.\n");
          return;
        }
        write(`${sessions.length} session${sessions.length === 1 ? "" : "s"}:\n`);
        for (const session of sessions) {
          const topic = session.topic ?? "(no topic)";
          write(`  • ${session.name} — ${topic}\n`);
          write(`    id: ${session.id}\n`);
          write(`    created: ${session.createdAt}\n`);
        }
      } finally {
        await db.destroy();
      }
    });
  return cmd;
}
