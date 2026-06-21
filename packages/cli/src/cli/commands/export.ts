/**
 * `council export <panel> --format markdown|json|adr [--output <path>]`
 * (ROADMAP §3.6)
 *
 * Snapshot the selected debate of a panel into a shareable artifact.
 * Three formats:
 *
 *   - **markdown** (default): readable transcript with H1 header
 *     (panel name + topic), a status line, and per-turn sections that
 *     include the expert displayName, model, round/seq, and content.
 *   - **json**: NDJSON stream identical to `council resume --format
 *     json` — same `synthesizeEvents()` helper. Useful as the
 *     canonical machine-readable archive.
 *   - **adr**: Architecture Decision Record markdown — Status,
 *     Context, Options Considered, Discussion, Decision sections
 *     populated from the panel's debate.
 *   - **share**: polished, launch-ready markdown that leads with the
 *     panel roster, key tensions, the recommendation, and next actions
 *     (derived from a recorded synthesis) before the full transcript.
 *     Synthesis-derived sections print an honest "Not recorded"
 *     placeholder when no synthesis was persisted — see `export-share.ts`.
 *
 * Pure read path: no engine, no LLM, and no debate-persistence side effects.
 * Reuses `synthesizeEvents()` from `src/memory/transcript.ts` (shared
 * with `council resume`). Unlike resume — which surfaces only the most
 * substantive single debate — export flattens every debate (original +
 * each resumption) into one continuous transcript so resumed sessions
 * don't lose earlier rounds. Panel name resolution mirrors resume's
 * exact-then-prefix fallback so `council export cfo` works when only
 * one panel name starts with `cfo`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Command, Option } from "commander";

import { getCouncilDataHome, getCouncilHome, loadConfig } from "../../config/index.js";
import { createDatabase, type CouncilDatabase } from "../../memory/db.js";
import { DebateRepository } from "../../memory/repositories/debates.js";
import { ExpertRepository } from "../../memory/repositories/experts.js";
import { PanelRepository } from "../../memory/repositories/panels.js";
import { TurnRepository, type Turn } from "../../memory/repositories/turns.js";
import { synthesizeEvents, type TranscriptDocument } from "../../memory/transcript.js";

import { CliUserError } from "../cli-user-error.js";
import { resolveSession } from "../session-resolver.js";
import { renderShare } from "./export-share.js";
import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";

export const EXPORT_FORMATS = ["markdown", "json", "adr", "share"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportCommandDeps {
  readonly write?: Writer;
  readonly writeError?: Writer;
}

export interface ExportOptions {
  readonly format: ExportFormat;
  readonly output?: string;
}

export function buildExportCommand(deps: ExportCommandDeps = {}): Command {
  const write: Writer = deps.write ?? defaultWriter;
  const writeError: Writer = deps.writeError ?? defaultErrorWriter;

  const cmd = new Command("export");
  cmd
    .description("Export a panel transcript to markdown, json, adr, or share format")
    .argument("<panel>", "Panel name to export (as shown by `council sessions`)")
    .addOption(
      new Option("--format <kind>", "Output format")
        .choices([...EXPORT_FORMATS])
        .default("markdown"),
    )
    .option("--output <path>", "Write to file instead of stdout (default: stdout)")
    .action(async (panelName: string, raw: ExportOptions) => {
      const opts: ExportOptions = {
        format: raw.format,
        ...(raw.output !== undefined ? { output: raw.output } : {}),
      };

      const councilHome = getCouncilHome();
      const dataHome = getCouncilDataHome();
      const dbPath = path.join(councilHome, "council.db");
      const db = await createDatabase(dbPath);
      try {
        let resolvedName: string;
        // Buffer stderr from the first attempt so we can discard it if we
        // retry with a different data home — emitting it eagerly would
        // print a contradictory "No panel found matching ..." line right
        // before the real "exists but has no debates yet ..." diagnostic.
        let firstAttemptStderr = "";
        const bufferedWriteError: Writer = (chunk: string) => {
          firstAttemptStderr += chunk;
        };
        try {
          resolvedName = await resolveSession({
            db,
            dataHome,
            panelArg: panelName,
            writeError: bufferedWriteError,
          });
        } catch (err: unknown) {
          const shouldRetryWithConfig =
            err instanceof CliUserError &&
            err.message.startsWith("No panel found matching") &&
            !process.env["COUNCIL_DATA_HOME"]?.length;
          if (!shouldRetryWithConfig) {
            writeError(firstAttemptStderr);
            throw err;
          }

          const configuredDataHome = getCouncilDataHome(await loadConfig());
          if (configuredDataHome === dataHome) {
            writeError(firstAttemptStderr);
            throw err;
          }
          resolvedName = await resolveSession({
            db,
            dataHome: configuredDataHome,
            panelArg: panelName,
            writeError,
          });
        }
        const doc = await loadFullPanelTranscript(db, resolvedName);
        const rendered = renderForExport(doc, opts.format);

        if (opts.output !== undefined) {
          await fs.writeFile(opts.output, rendered, { encoding: "utf8" });
          writeError(`Wrote ${opts.format} export to ${opts.output}\n`);
          if (opts.format !== "json") {
            write(
              `\x1b[2mNext: council conclude ${resolvedName} | council resume ${resolvedName}\x1b[0m\n`,
            );
          }
          return;
        }
        write(rendered);
        if (opts.format !== "json") {
          write(
            `\x1b[2mNext: council conclude ${resolvedName} | council resume ${resolvedName}\x1b[0m\n`,
          );
        }
      } finally {
        await db.destroy().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          writeError(`!! db.destroy() failed during cleanup: ${msg}\n`);
        });
      }
    });

  cmd.addHelpText(
    "after",
    `
Examples:
  $ council export my-panel                         # markdown to stdout
  $ council export my-panel --format adr            # Architecture Decision Record
  $ council export my-panel --format share          # polished, shareable summary
  $ council export my-panel --format json --output transcript.ndjson
`,
  );

  return cmd;
}

function renderForExport(doc: TranscriptDocument, format: ExportFormat): string {
  switch (format) {
    case "markdown":
      return renderMarkdown(doc);
    case "json":
      return renderJson(doc);
    case "adr":
      return renderAdr(doc);
    case "share":
      return renderShare(doc);
    default: {
      const _exhaustive: never = format;
      throw new Error(`Unknown export format: ${String(_exhaustive)}`);
    }
  }
}

function renderJson(doc: TranscriptDocument): string {
  // NDJSON identical to `council resume --format json`.
  return (
    synthesizeEvents(doc)
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n"
  );
}

function renderMarkdown(doc: TranscriptDocument): string {
  const slugById = new Map<string, string>();
  const nameBySlug = new Map<string, string>();
  const modelBySlug = new Map<string, string>();
  for (const e of doc.experts) {
    slugById.set(e.id, e.slug);
    nameBySlug.set(e.slug, e.displayName);
    modelBySlug.set(e.slug, e.model);
  }

  const lines: string[] = [];
  lines.push(`# ${doc.panel.name}`);
  if (doc.panel.topic) lines.push(`> ${doc.panel.topic}`);
  lines.push("");
  lines.push(`**Prompt:** ${doc.latestDebate.prompt}`);
  lines.push(`**Status:** ${doc.latestDebate.status}`);
  if (doc.latestDebate.endedAt) lines.push(`**Ended:** ${doc.latestDebate.endedAt}`);
  lines.push("");

  if (doc.experts.length > 0) {
    lines.push("## Panel");
    for (const e of doc.experts) {
      lines.push(`- **${e.displayName}** (\`${e.slug}\`) - ${e.model}`);
    }
    lines.push("");
  }

  lines.push("## Transcript");
  lines.push("");
  if (doc.turns.length === 0) {
    lines.push("_No turns recorded._");
    lines.push("");
  } else {
    let lastRound = -1;
    for (const t of doc.turns) {
      if (t.round !== lastRound) {
        lines.push(`### Round ${t.round + 1}`);
        lines.push("");
        lastRound = t.round;
      }
      const slug = t.expertId ? slugById.get(t.expertId) : undefined;
      const display = slug ? (nameBySlug.get(slug) ?? slug) : t.speakerKind;
      const model = slug ? modelBySlug.get(slug) : undefined;
      lines.push(`#### ${display}${model ? ` _(${model})_` : ""}`);
      lines.push("");
      // Indent multi-line content as a markdown block-quote so it
      // renders as the expert's "voice".
      for (const para of t.content.split("\n")) {
        lines.push(`> ${para}`);
      }
      lines.push("");
    }
  }

  lines.push(`---`);
  lines.push(`_Exported by Council on ${new Date().toISOString()}_`);
  return lines.join("\n") + "\n";
}

const ADR_SHORT_TURN_MAX_CHARS = 40;

function renderAdr(doc: TranscriptDocument): string {
  // Architecture Decision Record — populated from the panel's selected
  // debate. Heuristics: opening turn per expert = their position;
  // last turn per expert = their final synthesis (the Decision).
  const slugById = new Map<string, string>();
  const nameBySlug = new Map<string, string>();
  for (const e of doc.experts) {
    slugById.set(e.id, e.slug);
    nameBySlug.set(e.slug, e.displayName);
  }

  // For each expert: collect their first turn ("position") and last
  // turn ("synthesis"). May be the same turn for short debates.
  interface ExpertContrib {
    readonly displayName: string;
    readonly position: string;
    readonly synthesis: string;
  }
  const contribs = new Map<string, { firstTurn: string; lastTurn: string; displayName: string }>();
  for (const t of doc.turns) {
    if (!t.expertId) continue;
    const slug = slugById.get(t.expertId);
    if (!slug) continue;
    const displayName = nameBySlug.get(slug) ?? slug;
    const existing = contribs.get(slug);
    if (!existing) {
      contribs.set(slug, { firstTurn: t.content, lastTurn: t.content, displayName });
    } else {
      existing.lastTurn = t.content;
    }
  }
  const expertContribs: ExpertContrib[] = [];
  for (const c of contribs.values()) {
    expertContribs.push({
      displayName: c.displayName,
      position: c.firstTurn,
      synthesis: c.lastTurn,
    });
  }

  const status = deriveAdrStatus(doc);

  const lines: string[] = [];
  lines.push(`# Decision Record: ${doc.panel.topic ?? doc.originalPrompt}`);
  lines.push("");
  lines.push(`## Status`);
  lines.push("");
  lines.push(status);
  lines.push("");
  lines.push(`## Context`);
  lines.push("");
  lines.push(doc.originalPrompt);
  lines.push("");
  lines.push(`## Options Considered`);
  lines.push("");
  if (expertContribs.length === 0) {
    lines.push("_No expert positions recorded._");
  } else {
    for (const c of expertContribs) {
      lines.push(`### ${c.displayName}'s position`);
      lines.push("");
      for (const para of c.position.split("\n")) {
        lines.push(`> ${para}`);
      }
      lines.push("");
    }
  }
  lines.push(`## Discussion`);
  lines.push("");
  if (doc.turns.length <= expertContribs.length) {
    lines.push("_Single round — no further discussion recorded. See positions above._");
  } else {
    lines.push("Full transcript:");
    lines.push("");
    let lastRound = -1;
    for (const t of doc.turns) {
      if (t.round !== lastRound) {
        lines.push(`**Round ${t.round + 1}**`);
        lines.push("");
        lastRound = t.round;
      }
      const slug = t.expertId ? slugById.get(t.expertId) : undefined;
      const display = slug ? (nameBySlug.get(slug) ?? slug) : t.speakerKind;
      lines.push(`- **${display}**: ${t.content}`);
    }
    lines.push("");
  }
  lines.push(`## Decision`);
  lines.push("");
  if (expertContribs.length === 0) {
    lines.push("_No decision recorded._");
  } else {
    for (const c of expertContribs) {
      lines.push(`### ${c.displayName}'s final position`);
      lines.push("");
      for (const para of c.synthesis.split("\n")) {
        lines.push(`> ${para}`);
      }
      lines.push("");
    }
  }
  lines.push("---");
  lines.push(`_Generated by Council on ${new Date().toISOString()}_`);
  return lines.join("\n") + "\n";
}

function deriveAdrStatus(doc: TranscriptDocument): string {
  if (doc.latestDebate.status !== "completed") {
    return `${doc.latestDebate.status} (incomplete)`;
  }

  if (doc.turns.length <= 2 || hasOnlyVeryShortTurns(doc.turns)) {
    return "Proposed";
  }

  return "Accepted";
}

function hasOnlyVeryShortTurns(turns: readonly { readonly content: string }[]): boolean {
  return (
    turns.length > 0 &&
    turns.every((turn) => turn.content.trim().length <= ADR_SHORT_TURN_MAX_CHARS)
  );
}

/**
 * Load a panel's full conversational history for export — every debate
 * (original + every resumption) flattened into a single TranscriptDocument.
 *
 * Differs from `loadTranscript()` (used by resume), which intentionally
 * surfaces only the most-substantive single debate. Export needs the
 * complete record so resumed sessions don't lose earlier rounds.
 *
 * Round numbers are renumbered to be globally monotonic across debates
 * so the existing markdown/json/adr renderers produce a continuous
 * "Round 1, 2, 3, ..." sequence without needing any format changes.
 * `originalPrompt` is the first debate's prompt (the original question
 * the panel was convened around); `latestDebate` reflects the most
 * recent debate's status/timestamps.
 */
async function loadFullPanelTranscript(
  db: CouncilDatabase,
  panelName: string,
): Promise<TranscriptDocument> {
  const panelRepo = new PanelRepository(db);
  const expertRepo = new ExpertRepository(db);
  const debateRepo = new DebateRepository(db);
  const turnRepo = new TurnRepository(db);

  const panel = await panelRepo.findByName(panelName);
  if (!panel) {
    throw new Error(
      `No panel found with name '${panelName}'. Run \`council sessions\` to list available panels.`,
    );
  }
  const experts = await expertRepo.findByPanelId(panel.id);
  const debates = await debateRepo.findByPanelId(panel.id);
  if (debates.length === 0) {
    throw new Error(
      `Panel '${panelName}' has no debates yet. Run \`council convene\` to start one.`,
    );
  }

  const originalDebate = debates[0];
  const latestDebate = debates[debates.length - 1];
  if (!originalDebate || !latestDebate) {
    throw new Error(
      `Panel '${panelName}' has no debates yet. Run \`council convene\` to start one.`,
    );
  }

  const flattenedTurns: Turn[] = [];
  let roundOffset = 0;
  for (const debate of debates) {
    const debateTurns = await turnRepo.findByDebateId(debate.id);
    if (debateTurns.length === 0) continue;
    let maxRound = 0;
    for (const t of debateTurns) {
      flattenedTurns.push({ ...t, round: t.round + roundOffset });
      if (t.round > maxRound) maxRound = t.round;
    }
    roundOffset += maxRound + 1;
  }

  return {
    panel,
    experts,
    originalPrompt: originalDebate.prompt,
    latestDebate: {
      id: latestDebate.id,
      prompt: latestDebate.prompt,
      status: latestDebate.status,
      startedAt: latestDebate.startedAt,
      endedAt: latestDebate.endedAt,
    },
    turns: flattenedTurns,
  };
}
