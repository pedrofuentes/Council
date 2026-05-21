/**
 * `council sessions` — list all debate session records stored in Council's
 * local DB. (Renamed from `council panels` for clarity vs. `council panel`,
 * which manages the panel YAML library. The DB table is still `panels`.)
 */
import * as path from "node:path";

import { Command } from "commander";

import { getCouncilHome } from "../../config/index.js";
import { createDatabase } from "../../memory/db.js";
import { DebateRepository, type DebateStatus } from "../../memory/repositories/debates.js";
import { ExpertRepository } from "../../memory/repositories/experts.js";
import { PanelRepository } from "../../memory/repositories/panels.js";
import { TurnRepository } from "../../memory/repositories/turns.js";
import { getSymbols } from "../renderers/symbols.js";

import { defaultWriter, type Writer } from "./writer.js";

export interface SessionsCommandOptions {
  readonly format: "json" | "plain";
}

function statusIcon(status: DebateStatus | undefined): string {
  const symbols = getSymbols();
  switch (status) {
    case "completed":
      return symbols.complete;
    case "failed":
    case "aborted":
      return symbols.error;
    case "running":
      return symbols.paused;
    default:
      return " ";
  }
}

export function buildSessionsCommand(write: Writer = defaultWriter): Command {
  const cmd = new Command("sessions");
  cmd
    .description("List debate sessions (past runs). For panel templates, use `council panel list`.")
    .option("--format <kind>", "Output format: json (NDJSON) or plain (human-readable)", "plain")
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
          write('No sessions yet. Run `council convene "<topic>"` to create one.\n');
          return;
        }
        write(`${sessions.length} session${sessions.length === 1 ? "" : "s"}:\n`);

        const debateRepo = new DebateRepository(db);
        const expertRepo = new ExpertRepository(db);
        const turnRepo = new TurnRepository(db);

        for (const session of sessions) {
          const topic = session.topic ?? "(no topic)";
          const debates = await debateRepo.findByPanelId(session.id);
          const experts = await expertRepo.findByPanelId(session.id);
          const latest = debates.length > 0 ? debates[debates.length - 1] : undefined;
          let turnCount = 0;
          for (const d of debates) {
            const turns = await turnRepo.findByDebateId(d.id);
            turnCount += turns.length;
          }
          const icon = statusIcon(latest?.status);
          write(`  ${icon} ${session.name} — ${topic}\n`);
          write(`    panel: ${session.name}\n`);
          write(`    id: ${session.id}\n`);
          write(`    experts: ${experts.length}, turns: ${turnCount}\n`);
          write(`    created: ${session.createdAt}\n`);
        }

        write(
          "\nPanels are templates; sessions are debate runs. Use 'council panel list' for templates.\n",
        );
        write("\x1b[2mNext: council memory inspect <panel> | council export <panel>\x1b[0m\n");
      } finally {
        await db.destroy();
      }
    });
  return cmd;
}
