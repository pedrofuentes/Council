/**
 * `council resume <panel> [--continue "<prompt>"]` — reopens a panel
 * that already has at least one persisted debate (ROADMAP §3.2).
 *
 * Two modes:
 *   1. Transcript mode (no --continue) — replays the most recent
 *      debate's turns. No engine, no LLM.
 *   2. Continue mode (--continue) — runs a NEW debate against the
 *      same panel/experts via the shared `runWithEngine()` helper.
 */
import * as path from "node:path";

import { Command } from "commander";

import { getCouncilHome } from "../../config/index.js";
import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import { createDatabase } from "../../memory/db.js";
import {
  loadTranscript,
  synthesizeEvents,
  type TranscriptDocument,
} from "../../memory/transcript.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";
import { ENGINE_KINDS, type EngineKind, runWithEngine } from "../run-with-engine.js";

const DEFAULT_MAX_ROUNDS = 4;
const DEFAULT_MAX_WORDS = 250;

export interface ResumeCommandDeps {
  readonly engineFactory?: () => CouncilEngine;
  readonly write?: Writer;
  readonly writeError?: Writer;
}

export interface ResumeOptions {
  readonly format: "json" | "plain";
  readonly continue?: string;
  readonly engine?: EngineKind;
  readonly maxRounds: number;
  readonly maxWords: number;
}

export function buildResumeCommand(deps: ResumeCommandDeps = {}): Command {
  const write: Writer = deps.write ?? defaultWriter;
  const writeError: Writer = deps.writeError ?? defaultErrorWriter;

  const cmd = new Command("resume");
  cmd
    .description("Reopen a panel: show transcript, or continue with a new prompt")
    .argument("<panel>", "Panel name to resume (as shown by `council panels`)")
    .option("--format <kind>", "Output format: json (NDJSON) or plain (human)", "plain")
    .option(
      "--continue <prompt>",
      "Run a new debate against the same panel with this prompt",
    )
    .option(
      "--engine <kind>",
      "Engine for --continue mode: 'mock' (offline) or 'copilot' (real). Required when --continue is set.",
    )
    .option(
      "--max-rounds <n>",
      "Max rounds for --continue mode",
      (v) => Number.parseInt(v, 10),
      DEFAULT_MAX_ROUNDS,
    )
    .option(
      "--max-words <n>",
      "Soft per-response word cap for --continue mode",
      (v) => Number.parseInt(v, 10),
      DEFAULT_MAX_WORDS,
    )
    .action(async (panelName: string, raw: ResumeOptions) => {
      let engineKind: EngineKind | undefined;
      if (raw.continue !== undefined) {
        if (raw.engine === undefined) {
          throw new Error(
            "--engine is required with --continue (one of: mock, copilot). Use --engine mock for offline/deterministic, --engine copilot for real Copilot SDK.",
          );
        }
        if (!ENGINE_KINDS.includes(raw.engine)) {
          throw new Error(
            `Unknown --engine value: ${raw.engine}. Expected one of: ${ENGINE_KINDS.join(", ")}`,
          );
        }
        engineKind = raw.engine;
      }

      const opts: ResumeOptions = {
        format: raw.format === "json" ? "json" : "plain",
        ...(raw.continue !== undefined ? { continue: raw.continue } : {}),
        ...(engineKind !== undefined ? { engine: engineKind } : {}),
        maxRounds: Number.isFinite(raw.maxRounds) ? raw.maxRounds : DEFAULT_MAX_ROUNDS,
        maxWords: Number.isFinite(raw.maxWords) ? raw.maxWords : DEFAULT_MAX_WORDS,
      };

      const dbPath = path.join(getCouncilHome(), "council.db");
      const db = await createDatabase(dbPath);
      try {
        const resolved = await loadTranscript(db, panelName);

        if (opts.continue === undefined) {
          await renderTranscriptInline(resolved, opts.format, write);
          return;
        }

        const continueEngine = opts.engine ?? "mock";
        if (continueEngine === "mock") {
          writeError(
            "\n!! [MOCK ENGINE] --continue running with deterministic offline mock — responses are NOT real.\n\n",
          );
        }

        const expertSpecs = resolved.experts.map<ExpertSpec>((e) => ({
          id: e.id,
          slug: e.slug,
          displayName: e.displayName,
          model: e.model,
          systemMessage: e.systemMessage,
        }));

        const expertSlugToId: Record<string, string> = {};
        for (const e of resolved.experts) expertSlugToId[e.slug] = e.id;

        let panelMode: "freeform" | "structured" = "freeform";
        try {
          const cfg = JSON.parse(resolved.panel.configJson) as { mode?: string };
          if (cfg.mode === "structured") panelMode = "structured";
        } catch {
          /* malformed configJson — fall back to freeform */
        }

        await runWithEngine({
          engineKind: continueEngine,
          engineFactory: deps.engineFactory,
          experts: expertSpecs,
          debateConfig: {
            maxRounds: opts.maxRounds,
            maxWordsPerResponse: opts.maxWords,
            mode: panelMode,
          },
          prompt: opts.continue,
          panelId: resolved.panel.id,
          expertSlugToId,
          moderator: panelMode === "structured" ? "structured-phases" : "round-robin",
          format: opts.format,
          write,
          writeError,
          db,
          preamble:
            opts.format === "plain"
              ? () => {
                  write(`\n# Continuing ${resolved.panel.name}\n`);
                  write(`Prompt: ${opts.continue}\n`);
                  write(`Engine: ${continueEngine} | Max rounds: ${opts.maxRounds}\n\n`);
                }
              : undefined,
        });
      } finally {
        await db.destroy().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          writeError(`!! db.destroy() failed during cleanup: ${msg}\n`);
        });
      }
    });

  return cmd;
}

/**
 * Render a TranscriptDocument inline (plain or JSON). Plain mode is
 * resume-specific; JSON mode defers to `synthesizeEvents()`.
 */
async function renderTranscriptInline(
  resolved: TranscriptDocument,
  format: "json" | "plain",
  write: Writer,
): Promise<void> {
  if (format === "plain") {
    const slugById = new Map<string, string>();
    const nameBySlug = new Map<string, string>();
    for (const e of resolved.experts) {
      slugById.set(e.id, e.slug);
      nameBySlug.set(e.slug, e.displayName);
    }
    write(`\n# ${resolved.panel.name}\n`);
    if (resolved.panel.topic) write(`Topic: ${resolved.panel.topic}\n`);
    write(`Prompt: ${resolved.latestDebate.prompt}\n`);
    write(`Status: ${resolved.latestDebate.status}\n\n`);
    for (const t of resolved.turns) {
      const slug = t.expertId ? slugById.get(t.expertId) : undefined;
      const display = slug ? (nameBySlug.get(slug) ?? slug) : t.speakerKind;
      write(`${display} (round ${t.round}, seq ${t.seq}):\n`);
      write(`  ${t.content}\n\n`);
    }
    write(`--- end of transcript (${resolved.turns.length} turns) ---\n`);
    return;
  }

  for (const e of synthesizeEvents(resolved)) {
    write(JSON.stringify(e) + "\n");
  }
}
