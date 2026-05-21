/**
 * `council export <panel> --format markdown|json|adr [--output <path>]`
 * (ROADMAP §3.6)
 *
 * Snapshot the latest debate of a panel into a shareable artifact.
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
 *
 * Pure read path: no engine, no LLM, no persistence side effects.
 * Reuses `loadTranscript()` + `synthesizeEvents()` from
 * `src/memory/transcript.ts` (shared with `council resume`).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Command } from "commander";

import { getCouncilHome } from "../../config/index.js";
import { createDatabase } from "../../memory/db.js";
import {
  loadTranscript,
  synthesizeEvents,
  type TranscriptDocument,
} from "../../memory/transcript.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";

export const EXPORT_FORMATS = ["markdown", "json", "adr"] as const;
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
    .description("Export a panel transcript to markdown, json, or adr format")
    .argument("<panel>", "Panel name to export (as shown by `council sessions`)")
    .option("--format <kind>", `Output format: ${EXPORT_FORMATS.join(" | ")}`, "markdown")
    .option("--output <path>", "Write to file instead of stdout (default: stdout)")
    .action(async (panelName: string, raw: ExportOptions) => {
      if (!EXPORT_FORMATS.includes(raw.format)) {
        throw new Error(
          `Unknown --format value: ${raw.format}. Expected one of: ${EXPORT_FORMATS.join(", ")}`,
        );
      }
      const opts: ExportOptions = {
        format: raw.format,
        ...(raw.output !== undefined ? { output: raw.output } : {}),
      };

      const dbPath = path.join(getCouncilHome(), "council.db");
      const db = await createDatabase(dbPath);
      try {
        const doc = await loadTranscript(db, panelName);
        const rendered = renderForExport(doc, opts.format);

        if (opts.output !== undefined) {
          await fs.writeFile(opts.output, rendered, "utf-8");
          writeError(`Wrote ${opts.format} export to ${opts.output}\n`);
          return;
        }
        write(rendered);
      } finally {
        await db.destroy().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          writeError(`!! db.destroy() failed during cleanup: ${msg}\n`);
        });
      }
    });

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
      lines.push(`- **${e.displayName}** (\`${e.slug}\`) — ${e.model}`);
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

function renderAdr(doc: TranscriptDocument): string {
  // Architecture Decision Record — populated from the panel's latest
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

  const status =
    doc.latestDebate.status === "completed"
      ? "Accepted"
      : `${doc.latestDebate.status} (incomplete)`;

  const lines: string[] = [];
  lines.push(`# Decision Record: ${doc.panel.topic ?? doc.latestDebate.prompt}`);
  lines.push("");
  lines.push(`## Status`);
  lines.push("");
  lines.push(status);
  lines.push("");
  lines.push(`## Context`);
  lines.push("");
  lines.push(doc.latestDebate.prompt);
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
