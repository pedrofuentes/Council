/**
 * `council memory list/inspect/reset` (ROADMAP §3.5) — inspect and
 * curate the local SQLite state at the panel/expert/debate/turn level.
 *
 * Three subcommands:
 *
 *   - **list**: per-panel summary (name, expert count, debate count,
 *     turn count, last activity timestamp). Optional `--panel <name>`
 *     filter narrows to one panel. `--format json|plain`.
 *
 *   - **inspect <panel>**: detailed view of one panel: topic, latest
 *     debate prompt + status + turn count, expert displayNames + per-
 *     expert turn counts. With `--expert <slug>`: focuses on one
 *     expert showing their (truncated) system prompt + turn count.
 *
 *   - **reset <panel>**: destructive. Requires `--yes` flag (no
 *     interactive prompt — flag-only safety gate so accidental scripted
 *     destruction is harder). Three modes:
 *       - default: delete all debates + turns for the panel, KEEP the
 *         panel row + expert rows (panel is "ready to convene again").
 *       - `--hard`: delete the panel row entirely; FK CASCADE removes
 *         experts + debates + turns.
 *       - `--expert <slug>`: drop just one expert from the panel.
 *
 * No engine, no LLM. Pure DB read + targeted writes. Only `reset`
 * mutates state; `list` and `inspect` are read-only.
 *
 * Out of scope (deferred):
 *   - `--ephemeral` flag on convene (would need orchestrator awareness
 *     to skip persister writes; separate PR)
 *   - Real `expert_memory` table (positions, updatedPriors, etc.) —
 *     arrives with §3.1; will gain its own subcommands then
 *   - Bulk-all-panels export (use `council export <panel>` per-panel)
 *   - Encrypted-at-rest content
 */
import * as path from "node:path";

import { Command } from "commander";

import { getCouncilHome } from "../../config/index.js";
import { createDatabase, type CouncilDatabase } from "../../memory/db.js";
import { DebateRepository } from "../../memory/repositories/debates.js";
import { ExpertRepository, type Expert } from "../../memory/repositories/experts.js";
import {
  PanelRepository,
  type Panel,
} from "../../memory/repositories/panels.js";
import { TurnRepository } from "../../memory/repositories/turns.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";

export interface MemoryCommandDeps {
  readonly write?: Writer;
  readonly writeError?: Writer;
}

interface PanelSummary {
  readonly panelName: string;
  readonly panelId: string;
  readonly topic: string | null;
  readonly expertCount: number;
  readonly debateCount: number;
  readonly turnCount: number;
  readonly lastActivity: string | null;
}

const SYSTEM_PROMPT_PREVIEW_CHARS = 600;

export function buildMemoryCommand(deps: MemoryCommandDeps = {}): Command {
  const write: Writer = deps.write ?? defaultWriter;
  const writeError: Writer = deps.writeError ?? defaultErrorWriter;

  const cmd = new Command("memory");
  cmd.description("Inspect and curate Council's local SQLite state");

  cmd.addCommand(buildListCommand(write, writeError));
  cmd.addCommand(buildInspectCommand(write, writeError));
  cmd.addCommand(buildResetCommand(write, writeError));

  return cmd;
}

// ──────────────────────────────────────────────────────────────────────
// list
// ──────────────────────────────────────────────────────────────────────

function buildListCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("list");
  cmd
    .description("List all panels with persisted state summary")
    .option("--panel <name>", "Filter to a single panel")
    .option("--format <kind>", "Output format: plain (default) or json", "plain")
    .action(async (raw: { panel?: string; format?: string }) => {
      const format = raw.format === "json" ? "json" : "plain";
      const dbPath = path.join(getCouncilHome(), "council.db");
      const db = await createDatabase(dbPath);
      try {
        const summaries = await loadSummaries(db, raw.panel);
        if (raw.panel !== undefined && summaries.length === 0) {
          throw new Error(
            `No panel found with name '${raw.panel}'. Run \`council memory list\` to see available panels.`,
          );
        }

        if (format === "json") {
          for (const s of summaries) write(JSON.stringify(s) + "\n");
          return;
        }

        if (summaries.length === 0) {
          write("No panels in the local DB. Run `council convene` to create one.\n");
          return;
        }
        write(`\n${summaries.length} panel${summaries.length === 1 ? "" : "s"}:\n\n`);
        for (const s of summaries) {
          write(`• ${s.panelName}\n`);
          if (s.topic) write(`    topic: ${s.topic}\n`);
          write(
            `    experts: ${s.expertCount}, debates: ${s.debateCount}, turns: ${s.turnCount}\n`,
          );
          if (s.lastActivity) write(`    last activity: ${s.lastActivity}\n`);
          write("\n");
        }
      } finally {
        await db.destroy().catch((err: unknown) => {
          writeError(`!! db.destroy() failed during cleanup: ${err instanceof Error ? err.message : String(err)}\n`);
        });
      }
    });
  return cmd;
}

async function loadSummaries(
  db: CouncilDatabase,
  filterName?: string,
): Promise<PanelSummary[]> {
  const panelRepo = new PanelRepository(db);
  const expertRepo = new ExpertRepository(db);
  const debateRepo = new DebateRepository(db);
  const turnRepo = new TurnRepository(db);

  const allPanels = await panelRepo.findAll();
  const panels = filterName ? allPanels.filter((p) => p.name === filterName) : allPanels;

  const summaries: PanelSummary[] = [];
  for (const p of panels) {
    const experts = await expertRepo.findByPanelId(p.id);
    const debates = await debateRepo.findByPanelId(p.id);
    let turnCount = 0;
    let lastActivity: string | null = null;
    for (const d of debates) {
      const turns = await turnRepo.findByDebateId(d.id);
      turnCount += turns.length;
      const ts = d.endedAt ?? d.startedAt;
      if (lastActivity === null || ts > lastActivity) lastActivity = ts;
    }
    summaries.push({
      panelName: p.name,
      panelId: p.id,
      topic: p.topic,
      expertCount: experts.length,
      debateCount: debates.length,
      turnCount,
      lastActivity,
    });
  }
  return summaries;
}

// ──────────────────────────────────────────────────────────────────────
// inspect
// ──────────────────────────────────────────────────────────────────────

function buildInspectCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("inspect");
  cmd
    .description("Show detailed state for a single panel")
    .argument("<panel>", "Panel name to inspect")
    .option("--expert <slug>", "Focus on a single expert by slug")
    .option("--format <kind>", "Output format: plain (default) or json", "plain")
    .action(async (panelName: string, raw: { expert?: string; format?: string }) => {
      const format = raw.format === "json" ? "json" : "plain";
      const dbPath = path.join(getCouncilHome(), "council.db");
      const db = await createDatabase(dbPath);
      try {
        const panel = await new PanelRepository(db).findByName(panelName);
        if (!panel) {
          throw new Error(
            `No panel found with name '${panelName}'. Run \`council memory list\` to see available panels.`,
          );
        }
        const experts = await new ExpertRepository(db).findByPanelId(panel.id);

        if (raw.expert !== undefined) {
          const expert = experts.find((e) => e.slug === raw.expert);
          if (!expert) {
            throw new Error(
              `No expert found with slug '${raw.expert}' in panel '${panelName}'. Available slugs: ${experts.map((e) => e.slug).join(", ") || "(none)"}`,
            );
          }
          await renderExpertDetail(db, panel, expert, format, write);
          return;
        }
        await renderPanelDetail(db, panel, experts, format, write);
      } finally {
        await db.destroy().catch((err: unknown) => {
          writeError(`!! db.destroy() failed during cleanup: ${err instanceof Error ? err.message : String(err)}\n`);
        });
      }
    });
  return cmd;
}

async function renderPanelDetail(
  db: CouncilDatabase,
  panel: Panel,
  experts: readonly Expert[],
  format: "plain" | "json",
  write: Writer,
): Promise<void> {
  const debates = await new DebateRepository(db).findByPanelId(panel.id);
  const latest = debates.length > 0 ? debates[debates.length - 1] : undefined;
  const turns = latest ? await new TurnRepository(db).findByDebateId(latest.id) : [];

  if (format === "json") {
    const doc = {
      panelName: panel.name,
      panelId: panel.id,
      topic: panel.topic,
      experts: experts.map((e) => ({ slug: e.slug, displayName: e.displayName, model: e.model })),
      debateCount: debates.length,
      latestDebate: latest
        ? {
            id: latest.id,
            prompt: latest.prompt,
            status: latest.status,
            startedAt: latest.startedAt,
            endedAt: latest.endedAt,
            turnCount: turns.length,
          }
        : null,
    };
    write(JSON.stringify(doc) + "\n");
    return;
  }

  write(`\n# ${panel.name}\n`);
  if (panel.topic) write(`Topic: ${panel.topic}\n`);
  write(`\nExperts (${experts.length}):\n`);
  for (const e of experts) {
    write(`  • ${e.displayName} (${e.slug}) — ${e.model}\n`);
  }
  if (!latest) {
    write(`\nNo debates yet for this panel.\n`);
    return;
  }
  write(`\nLatest debate:\n`);
  write(`  prompt: ${latest.prompt}\n`);
  write(`  status: ${latest.status}\n`);
  write(`  turns: ${turns.length}\n`);
  write(`  started: ${latest.startedAt}\n`);
  if (latest.endedAt) write(`  ended:   ${latest.endedAt}\n`);
  write(`\n${debates.length} debate${debates.length === 1 ? "" : "s"} total for this panel.\n`);
}

async function renderExpertDetail(
  db: CouncilDatabase,
  panel: Panel,
  expert: Expert,
  format: "plain" | "json",
  write: Writer,
): Promise<void> {
  const debates = await new DebateRepository(db).findByPanelId(panel.id);
  let expertTurnCount = 0;
  for (const d of debates) {
    const turns = await new TurnRepository(db).findByDebateId(d.id);
    expertTurnCount += turns.filter((t) => t.expertId === expert.id).length;
  }

  if (format === "json") {
    write(
      JSON.stringify({
        panelName: panel.name,
        expert: {
          slug: expert.slug,
          displayName: expert.displayName,
          model: expert.model,
          systemMessage: expert.systemMessage,
          turnCount: expertTurnCount,
        },
      }) + "\n",
    );
    return;
  }

  write(`\n# ${expert.displayName} (${expert.slug}) in ${panel.name}\n`);
  write(`Model: ${expert.model}\n`);
  write(`Turns by this expert: ${expertTurnCount}\n`);
  write(`\nSystem prompt (preview, ${SYSTEM_PROMPT_PREVIEW_CHARS} chars):\n`);
  write(`---\n`);
  const preview =
    expert.systemMessage.length > SYSTEM_PROMPT_PREVIEW_CHARS
      ? expert.systemMessage.slice(0, SYSTEM_PROMPT_PREVIEW_CHARS) + "\n[... truncated]"
      : expert.systemMessage;
  write(preview + "\n");
  write(`---\n`);
}

// ──────────────────────────────────────────────────────────────────────
// reset
// ──────────────────────────────────────────────────────────────────────

function buildResetCommand(write: Writer, writeError: Writer): Command {
  const cmd = new Command("reset");
  cmd
    .description("Delete persisted state for a panel (destructive — requires --yes)")
    .argument("<panel>", "Panel name to reset")
    .option("--yes", "Confirm the destructive operation (REQUIRED — no interactive prompt)")
    .option("--hard", "Delete the entire panel (CASCADE removes experts + debates + turns)")
    .option("--expert <slug>", "Drop only this expert from the panel (keeps panel + others)")
    .action(
      async (
        panelName: string,
        raw: { yes?: boolean; hard?: boolean; expert?: string },
      ) => {
        if (!raw.yes) {
          throw new Error(
            `Refusing destructive operation without --yes. \`council memory reset\` requires the --yes flag explicitly so accidental scripted destruction is harder. Re-run with --yes if you mean it.`,
          );
        }

        const dbPath = path.join(getCouncilHome(), "council.db");
        const db = await createDatabase(dbPath);
        try {
          const panel = await new PanelRepository(db).findByName(panelName);
          if (!panel) {
            throw new Error(
              `No panel found with name '${panelName}'. Run \`council memory list\` to see available panels.`,
            );
          }

          if (raw.expert !== undefined) {
            const experts = await new ExpertRepository(db).findByPanelId(panel.id);
            const expert = experts.find((e) => e.slug === raw.expert);
            if (!expert) {
              throw new Error(
                `No expert found with slug '${raw.expert}' in panel '${panelName}'. Available slugs: ${experts.map((e) => e.slug).join(", ") || "(none)"}`,
              );
            }
            await new ExpertRepository(db).delete(expert.id);
            write(
              `Removed expert '${expert.slug}' (${expert.displayName}) from panel '${panel.name}'.\n`,
            );
            return;
          }

          if (raw.hard) {
            await new PanelRepository(db).delete(panel.id);
            write(
              `Deleted panel '${panel.name}' entirely (FK CASCADE removed experts, debates, and turns).\n`,
            );
            return;
          }

          // Default: delete debates+turns for this panel; keep panel+experts.
          // Debate deletion CASCADEs to turns via the FK at migration 001.
          const debates = await new DebateRepository(db).findByPanelId(panel.id);
          for (const d of debates) {
            await db.deleteFrom("debates").where("id", "=", d.id).execute();
          }
          write(
            `Reset panel '${panel.name}': deleted ${debates.length} debate${debates.length === 1 ? "" : "s"} and their turns. Panel + experts kept (run \`council convene\` to start fresh).\n`,
          );
        } finally {
          await db.destroy().catch((err: unknown) => {
            writeError(`!! db.destroy() failed during cleanup: ${err instanceof Error ? err.message : String(err)}\n`);
          });
        }
      },
    );
  return cmd;
}
