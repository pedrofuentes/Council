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
import { type Panel, PanelRepository } from "../../memory/repositories/panels.js";
import { TurnRepository } from "../../memory/repositories/turns.js";
import { getSymbols } from "../renderers/symbols.js";

import { createReadlineConfirmProvider, type ConfirmProvider } from "./confirm.js";
import { defaultWriter, type Writer } from "./writer.js";

export interface SessionsCommandOptions {
  readonly format: "json" | "plain";
}

export interface SessionsCommandDeps {
  readonly write?: Writer;
  readonly confirmProvider?: () => ConfirmProvider;
}

interface CancelSessionsOptions {
  readonly all?: boolean;
}

interface DeleteSessionOptions {
  readonly yes?: boolean;
}

const STUCK_RUNNING_DEBATE_THRESHOLD_MS = 60 * 60 * 1000;

function statusIcon(status: DebateStatus | undefined): string {
  const symbols = getSymbols();
  switch (status) {
    case "completed":
      return symbols.complete;
    case "interrupted":
      return symbols.warn;
    case "failed":
    case "aborted":
      return symbols.error;
    case "running":
      return symbols.paused;
    default:
      return " ";
  }
}

function truncateTopic(topic: string | null, maxLength: number): string {
  if (topic === null) return "(no topic)";
  if (topic.length <= maxLength) return topic;
  return topic.slice(0, maxLength - 3) + "...";
}

function isPossiblyStuckRunningDebate(
  status: DebateStatus | undefined,
  lastActivityAt: string | undefined,
): boolean {
  if (status !== "running" || lastActivityAt === undefined) {
    return false;
  }

  const lastActivityMs = Date.parse(lastActivityAt);
  return Number.isFinite(lastActivityMs) && Date.now() - lastActivityMs > STUCK_RUNNING_DEBATE_THRESHOLD_MS;
}

function formatStuckSessionHint(panelName: string): string {
  return `${getSymbols().warn} May be stuck — try: council resume ${panelName}`;
}

async function findPanelByNameOrPrefix(
  panelRepo: PanelRepository,
  requestedName: string,
): Promise<Panel | undefined> {
  const exactMatch = await panelRepo.findByName(requestedName);
  if (exactMatch) {
    return exactMatch;
  }

  const prefixMatches = await panelRepo.findByNamePrefix(requestedName);
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Ambiguous prefix '${requestedName}' matches ${prefixMatches.length} panels.`);
  }

  return undefined;
}

function hasRunningDebate(panelDebates: readonly { status: DebateStatus }[]): boolean {
  return panelDebates.some((debate) => debate.status === "running");
}

function resolveSessionsCommandDeps(depsOrWrite: SessionsCommandDeps | Writer | undefined): {
  write: Writer;
  confirmProvider: () => ConfirmProvider;
} {
  if (typeof depsOrWrite === "function") {
    return {
      write: depsOrWrite,
      confirmProvider: createReadlineConfirmProvider,
    };
  }

  return {
    write: depsOrWrite?.write ?? defaultWriter,
    confirmProvider: depsOrWrite?.confirmProvider ?? createReadlineConfirmProvider,
  };
}

export function buildSessionsCommand(depsOrWrite?: SessionsCommandDeps | Writer): Command {
  const { write, confirmProvider } = resolveSessionsCommandDeps(depsOrWrite);
  const cmd = new Command("sessions");
  cmd.alias("history");
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
          const topic = truncateTopic(session.topic, 80);
          const debates = await debateRepo.findByPanelId(session.id);
          const experts = await expertRepo.findByPanelId(session.id);
          const latest = debates.length > 0 ? debates[debates.length - 1] : undefined;
          let turnCount = 0;
          for (const d of debates) {
            turnCount += await turnRepo.countByDebateId(d.id);
          }
          const latestTurn = latest ? await turnRepo.findLatestByDebateId(latest.id) : undefined;
          const latestActivityAt = latestTurn?.createdAt ?? latest?.startedAt;
          const icon = statusIcon(latest?.status);
          write(`  ${icon} ${session.name} — ${topic}\n`);
          write(`    panel: ${session.name}\n`);
          write(`    id: ${session.id}\n`);
          write(`    status: ${latest?.status ?? "none"}\n`);
          if (isPossiblyStuckRunningDebate(latest?.status, latestActivityAt)) {
            write(`    ${formatStuckSessionHint(session.name)}\n`);
          }
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

  cmd
    .command("cancel")
    .description("Mark stale running debates as interrupted")
    .argument("[name]", "Panel name to cancel (supports unique prefix matching)")
    .option("--all", "Cancel all running debates")
    .action(async (name: string | undefined, options: CancelSessionsOptions) => {
      const dbPath = path.join(getCouncilHome(), "council.db");
      const db = await createDatabase(dbPath);
      try {
        const debateRepo = new DebateRepository(db);
        if (options.all === true) {
          const cancelled = await debateRepo.cancelAllRunning();
          if (cancelled === 0) {
            write("No running debates found.\n");
            return;
          }
          write(`Cancelled ${cancelled} running debate${cancelled === 1 ? "" : "s"}.\n`);
          return;
        }

        const requestedName = name?.trim();
        if (!requestedName) {
          throw new Error("Panel name is required unless --all is set.");
        }

        const panelRepo = new PanelRepository(db);
        const panel = await findPanelByNameOrPrefix(panelRepo, requestedName);
        if (!panel) {
          write(`No panel found matching '${requestedName}'.\n`);
          return;
        }

        const cancelled = await debateRepo.cancelRunning(panel.id);
        if (!cancelled) {
          write(`No running debates found for panel '${panel.name}'.\n`);
          return;
        }

        write(`Cancelled running debate for panel '${panel.name}'.\n`);
      } finally {
        await db.destroy();
      }
    });

  cmd
    .command("delete")
    .description("Delete a completed or interrupted session")
    .argument("<name>", "Session name to delete (supports unique prefix matching)")
    .option("--yes", "Skip confirmation prompt")
    .action(async (name: string, options: DeleteSessionOptions) => {
      const requestedName = name.trim();
      const dbPath = path.join(getCouncilHome(), "council.db");
      const db = await createDatabase(dbPath);
      try {
        const panelRepo = new PanelRepository(db);
        const debateRepo = new DebateRepository(db);
        const panel = await findPanelByNameOrPrefix(panelRepo, requestedName);
        if (!panel) {
          write(`No session found matching '${requestedName}'.\n`);
          return;
        }

        const debates = await debateRepo.findByPanelId(panel.id);
        if (hasRunningDebate(debates)) {
          throw new Error("Cannot delete a running session. Cancel it first.");
        }

        if (options.yes !== true) {
          const confirmed = await confirmProvider().confirm(
            `Delete session ${panel.name}? This cannot be undone. (y/N) `,
          );
          if (!confirmed) {
            write("Deletion aborted.\n");
            return;
          }
        }

        await panelRepo.delete(panel.id);
        write(`Deleted session '${panel.name}'.\n`);
      } finally {
        await db.destroy();
      }
    });

  return cmd;
}
