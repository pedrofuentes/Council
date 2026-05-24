/**
 * `council resume <panel> [--prompt "<prompt>"]` — reopens a panel
 * that already has at least one persisted debate (ROADMAP §3.2).
 *
 * Two modes:
 *   1. Transcript mode (no --prompt) — replays the selected debate's
 *      turns. No engine, no LLM.
 *   2. Continue mode (--prompt, or auto-resume from an interrupted
 *      latest debate) — runs a NEW debate against the same panel/
 *      experts via the shared `runWithEngine()` helper.
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
import { createDatabase } from "../../memory/db.js";
import { DebateRepository } from "../../memory/repositories/debates.js";
import { applyRecalledMemory, recallMemory } from "../../memory/expert-memory.js";
import {
  loadTranscript,
  synthesizeEvents,
  type TranscriptDocument,
} from "../../memory/transcript.js";
import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";
import { runExtractMemoryHook } from "../extract-memory-hook.js";
import { RENDERER_FORMATS, type RendererFormat } from "../renderers/select.js";
import { ENGINE_KINDS, type EngineKind, runWithEngine } from "../run-with-engine.js";
import { resolveSession } from "../session-resolver.js";
import { resolveStrategy, STRATEGY_NAMES } from "../strategy-resolver.js";

const DEFAULT_MAX_ROUNDS_CONTINUE = 1; // for resume --prompt (follow-up questions)
const DEFAULT_MAX_ROUNDS_TRANSCRIPT = 4; // fallback (transcript mode doesn't use rounds)
const DEFAULT_MAX_WORDS = 250;

export interface ResumeCommandDeps {
  readonly engineFactory?: () => CouncilEngine;
  readonly write?: Writer;
  readonly writeError?: Writer;
  readonly subscribeInterrupt?: (handler: () => void) => () => void;
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
    .addOption(new Option("--engine <kind>", "Engine for continue mode").choices([...ENGINE_KINDS]))
    .option("--max-rounds <n>", "Max rounds for --prompt mode (default: 1)", (v) =>
      Number.parseInt(v, 10),
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
      const councilHome = getCouncilHome();
      const dbPath = path.join(councilHome, "council.db");
      const db = await createDatabase(dbPath);
      try {
        const panelName = await resolveSession({
          db,
          dataHome: councilHome,
          panelArg,
          latest: raw.latest === true,
          writeError,
          missingPanelMessage:
            "Panel name is required. Use `council resume <name>` or `council resume --latest`.",
        });
        const resolved = await loadTranscript(db, panelName);
        const debates = await new DebateRepository(db).findByPanelId(resolved.panel.id);
        const latestDebate = debates[debates.length - 1];
        const autoResumePrompt =
          raw.prompt === undefined && latestDebate?.status === "interrupted"
            ? latestDebate.prompt
            : undefined;
        const continuePrompt = raw.prompt ?? autoResumePrompt;
        const isContinueMode = continuePrompt !== undefined;

        let engineKind: EngineKind | undefined;
        let defaultModel: string | undefined;
        if (isContinueMode) {
          const config = await loadConfig();
          engineKind = resolveEngine(raw.engine, config);
          defaultModel = config.defaults.model;
        }

        const opts: ResumeOptions = {
          format: parseFormat(raw.format),
          ...(continuePrompt !== undefined ? { prompt: continuePrompt } : {}),
          ...(engineKind !== undefined ? { engine: engineKind } : {}),
          maxRounds: Number.isFinite(raw.maxRounds)
            ? raw.maxRounds
            : isContinueMode
              ? DEFAULT_MAX_ROUNDS_CONTINUE
              : DEFAULT_MAX_ROUNDS_TRANSCRIPT,
          maxWords: Number.isFinite(raw.maxWords) ? raw.maxWords : DEFAULT_MAX_WORDS,
          ...(raw.strategy !== undefined ? { strategy: raw.strategy } : {}),
          heuristicMemory: raw.heuristicMemory === true,
          latest: raw.latest === true,
        };

        if (opts.prompt === undefined) {
          // Transcript replay: "auto" degrades to plain (Ink would just
          // render a static dump — no streaming benefit).
          const transcriptFormat: "json" | "plain" = opts.format === "json" ? "json" : "plain";
          await renderTranscriptInline(resolved, transcriptFormat, write);
          return;
        }

        const debateController = new AbortController();
        let debateInterrupted = false;
        let unsubscribeInterrupt: () => void = () => undefined;
        const onInterrupt = (): void => {
          debateInterrupted = true;
          unsubscribeInterrupt();
          debateController.abort();
        };
        const subscribeInterrupt = deps.subscribeInterrupt ?? defaultSubscribeInterrupt;
        unsubscribeInterrupt = subscribeInterrupt(onInterrupt);

        try {
          if (autoResumePrompt !== undefined) {
            writeError("Resuming interrupted debate...\n");
          }

          const continueEngine = opts.engine ?? "mock";
          if (continueEngine === "mock") {
            writeError(
              "\n!! [MOCK ENGINE] resume continue mode running with deterministic offline mock — responses are NOT real.\n\n",
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
              panelMode === "structured"
                ? "structured-phases"
                : (strategy?.name ?? "round-robin"),
            format: opts.format,
            write,
            writeError,
            db,
            signal: debateController.signal,
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
          unsubscribeInterrupt();
        }
        if (debateInterrupted) {
          writeError("\nDebate interrupted. Partial results saved.\n");
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
  $ council resume my-panel                                          # show transcript
  $ council resume my-panel --prompt "What about costs?" --engine copilot  # continue debate
  $ council resume my-panel                                          # auto-continues if latest debate was interrupted
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

function defaultSubscribeInterrupt(handler: () => void): () => void {
  process.on("SIGINT", handler);
  return () => {
    process.off("SIGINT", handler);
  };
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
