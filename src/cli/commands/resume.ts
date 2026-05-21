/**
 * `council resume <panel> [--prompt "<prompt>"]` — reopens a panel
 * that already has at least one persisted debate (ROADMAP §3.2).
 *
 * Two modes:
 *   1. Transcript mode (no --prompt) — replays the most recent
 *      debate's turns. No engine, no LLM.
 *   2. Continue mode (--prompt) — runs a NEW debate against the
 *      same panel/experts via the shared `runWithEngine()` helper.
 *
 * Panel resolution:
 *   - Exact match first
 *   - Prefix match if no exact match (auto-select if unique, error if ambiguous)
 *   - `--latest` skips name lookup and resumes the most recent panel
 */
import * as path from "node:path";

import { Command, Option } from "commander";

import { DEFAULT_MODEL, getCouncilHome, loadConfig, resolveEngine } from "../../config/index.js";
import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import { createDatabase, type CouncilDatabase } from "../../memory/db.js";
import { applyRecalledMemory, recallMemory } from "../../memory/expert-memory.js";
import {
  loadTranscript,
  synthesizeEvents,
  type TranscriptDocument,
} from "../../memory/transcript.js";
import { PanelRepository } from "../../memory/repositories/panels.js";

import { CliUserError } from "../cli-user-error.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";
import { ENGINE_KINDS, type EngineKind, runWithEngine } from "../run-with-engine.js";
import { runExtractMemoryHook } from "../extract-memory-hook.js";
import { RENDERER_FORMATS, type RendererFormat } from "../renderers/select.js";
import { resolveStrategy, STRATEGY_NAMES } from "../strategy-resolver.js";

const DEFAULT_MAX_ROUNDS = 4;
const DEFAULT_MAX_WORDS = 250;

export interface ResumeCommandDeps {
  readonly engineFactory?: () => CouncilEngine;
  readonly write?: Writer;
  readonly writeError?: Writer;
}

export interface ResumeOptions {
  readonly format: RendererFormat;
  readonly prompt?: string;
  readonly engine?: EngineKind;
  readonly maxRounds: number;
  readonly maxWords: number;
  readonly strategy?: string;
  readonly heuristicMemory?: boolean;
  readonly latest?: boolean;
}

export function buildResumeCommand(deps: ResumeCommandDeps = {}): Command {
  const write: Writer = deps.write ?? defaultWriter;
  const writeError: Writer = deps.writeError ?? defaultErrorWriter;

  const cmd = new Command("resume");
  cmd
    .description("Reopen a panel: show transcript, or continue with a new prompt")
    .argument("[panel]", "Panel name to resume (as shown by `council sessions`)")
    .addOption(
      new Option("--format <kind>", "Output format").choices([...RENDERER_FORMATS]).default("auto"),
    )
    .option("--prompt <prompt>", "Run a new debate against the same panel with this prompt")
    .addOption(new Option("--engine <kind>", "Engine for --prompt mode").choices([...ENGINE_KINDS]))
    .option(
      "--max-rounds <n>",
      "Max rounds for --prompt mode",
      (v) => Number.parseInt(v, 10),
      DEFAULT_MAX_ROUNDS,
    )
    .option(
      "--max-words <n>",
      "Soft per-response word cap for --prompt mode",
      (v) => Number.parseInt(v, 10),
      DEFAULT_MAX_WORDS,
    )
    .option(
      "--strategy <name>",
      `Moderator strategy for --prompt freeform mode (${STRATEGY_NAMES.join(" | ")}). ` +
        `devils-advocate accepts an optional ":<slug>" suffix.`,
      "round-robin",
    )
    .option(
      "--heuristic-memory",
      "Skip post-debate LLM extraction — for offline/air-gapped use. " +
        "Useful for offline tests and air-gapped environments.",
    )
    .option("--latest", "Resume the most recent panel session")
    .action(async (panelArg: string | undefined, raw: ResumeOptions) => {
      let engineKind: EngineKind | undefined;
      let defaultModel: string | undefined;
      if (raw.prompt !== undefined) {
        const config = await loadConfig();
        engineKind = resolveEngine(raw.engine, config);
        defaultModel = config.defaults.model;
      }

      const opts: ResumeOptions = {
        format: parseFormat(raw.format),
        ...(raw.prompt !== undefined ? { prompt: raw.prompt } : {}),
        ...(engineKind !== undefined ? { engine: engineKind } : {}),
        maxRounds: Number.isFinite(raw.maxRounds) ? raw.maxRounds : DEFAULT_MAX_ROUNDS,
        maxWords: Number.isFinite(raw.maxWords) ? raw.maxWords : DEFAULT_MAX_WORDS,
        ...(raw.strategy !== undefined ? { strategy: raw.strategy } : {}),
        heuristicMemory: raw.heuristicMemory === true,
        latest: raw.latest === true,
      };

      const dbPath = path.join(getCouncilHome(), "council.db");
      const db = await createDatabase(dbPath);
      try {
        // Resolve panel name: --latest, exact match, or prefix match
        const panelName = await resolvePanelName(panelArg, opts.latest === true, db, writeError);
        const resolved = await loadTranscript(db, panelName);

        if (opts.prompt === undefined) {
          // Transcript replay: "auto" degrades to plain (Ink would just
          // render a static dump — no streaming benefit).
          const transcriptFormat: "json" | "plain" = opts.format === "json" ? "json" : "plain";
          await renderTranscriptInline(resolved, transcriptFormat, write);
          return;
        }

        const continueEngine = opts.engine ?? "mock";
        if (continueEngine === "mock") {
          writeError(
            "\n!! [MOCK ENGINE] --prompt running with deterministic offline mock — responses are NOT real.\n\n",
          );
        }

        const recalls = await Promise.all(
          resolved.experts.map((e) => recallMemory(db, resolved.panel.id, e.slug)),
        );
        const expertSpecs: ExpertSpec[] = resolved.experts.map((e, i) => ({
          id: e.id,
          slug: e.slug,
          displayName: e.displayName,
          model: e.model,
          systemMessage: applyRecalledMemory(e.systemMessage, recalls[i]),
        }));

        const expertSlugToId: Record<string, string> = {};
        for (const e of resolved.experts) expertSlugToId[e.slug] = e.id;

        let panelMode: "freeform" | "structured" = "freeform";
        try {
          const cfg = JSON.parse(resolved.panel.configJson) as { mode?: string };
          if (cfg.mode === "structured") panelMode = "structured";
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          writeError(
            `!! Warning: could not parse panel config for "${resolved.panel.name}" — ` +
              `malformed configJson (${msg}); falling back to freeform mode.\n`,
          );
        }

        const strategy =
          panelMode === "freeform" && opts.strategy !== undefined
            ? resolveStrategy({ raw: opts.strategy, experts: expertSpecs })
            : undefined;

        await runWithEngine({
          engineKind: continueEngine,
          engineFactory: deps.engineFactory,
          experts: expertSpecs,
          debateConfig: {
            maxRounds: opts.maxRounds,
            maxWordsPerResponse: opts.maxWords,
            mode: panelMode,
            ...(strategy !== undefined ? { strategy } : {}),
          },
          prompt: opts.prompt,
          panelId: resolved.panel.id,
          expertSlugToId,
          moderator:
            panelMode === "structured" ? "structured-phases" : (strategy?.name ?? "round-robin"),
          format: opts.format,
          write,
          writeError,
          db,
          preamble: () => {
            write(`\n# Continuing ${resolved.panel.name}\n`);
            write(`Prompt: ${opts.prompt}\n`);
            write(`Engine: ${continueEngine} | Max rounds: ${opts.maxRounds}\n\n`);
          },
          ...(opts.heuristicMemory === true
            ? {}
            : {
                onDebateComplete: async (ctx) =>
                  runExtractMemoryHook({
                    engine: ctx.engine,
                    db: ctx.db,
                    panelId: ctx.panelId,
                    debateId: ctx.debateId,
                    expertSlugToId: ctx.expertSlugToId,
                    humanSlugs: new Set<string>(),
                    model: defaultModel ?? DEFAULT_MODEL,
                    writeError,
                  }),
              }),
        });
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
  $ council resume my-panel                                          # show transcript
  $ council resume my-panel --prompt "What about costs?" --engine copilot  # continue debate
  $ council resume --latest                                          # most recent panel
  $ council resume arch                                              # prefix match
`,
  );

  return cmd;
}

function parseFormat(raw: string | undefined): RendererFormat {
  if (raw === undefined) return "auto";
  if ((RENDERER_FORMATS as readonly string[]).includes(raw)) {
    return raw as RendererFormat;
  }
  throw new Error(
    `Unknown --format value: ${raw}. Expected one of: ${RENDERER_FORMATS.join(", ")}`,
  );
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
    write(
      `\nTo continue this debate: council resume ${resolved.panel.name} --prompt "<new question>" --engine copilot\n`,
    );
    return;
  }

  for (const e of synthesizeEvents(resolved)) {
    write(JSON.stringify(e) + "\n");
  }
}

/**
 * Resolve a panel name from CLI input using:
 *   1. --latest → most-recently-created panel
 *   2. Exact match by name
 *   3. Prefix match (auto-select if unique, error if ambiguous)
 */
async function resolvePanelName(
  panelArg: string | undefined,
  latest: boolean,
  db: CouncilDatabase,
  writeError: Writer,
): Promise<string> {
  const panelRepo = new PanelRepository(db);

  if (latest) {
    const panel = await panelRepo.findMostRecentlyActive();
    if (!panel) {
      writeError("No panels found. Run `council convene` to start one.\n");
      throw new CliUserError("No panels found");
    }
    return panel.name;
  }

  if (!panelArg) {
    writeError(
      "Panel name is required. Use `council resume <name>` or `council resume --latest`.\n",
    );
    throw new CliUserError("Panel name is required");
  }

  // Try exact match first
  const exact = await panelRepo.findByName(panelArg);
  if (exact) return exact.name;

  // Try prefix match
  const prefixMatches = await panelRepo.findByNamePrefix(panelArg);
  if (prefixMatches.length === 1) {
    const match = prefixMatches[0];
    if (match) return match.name;
  }
  if (prefixMatches.length > 1) {
    const names = prefixMatches.map((p) => p.name);
    writeError(`Multiple panels match "${panelArg}":\n`);
    for (const n of names) {
      writeError(`  • ${n}\n`);
    }
    throw new CliUserError(
      `Ambiguous prefix "${panelArg}" matches ${prefixMatches.length} panels: ${names.join(", ")}`,
    );
  }

  // No match at all — let loadTranscript produce the standard error
  return panelArg;
}
