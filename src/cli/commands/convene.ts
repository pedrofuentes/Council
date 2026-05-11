/**
 * `council convene <topic> --template <name> --engine <kind>` — runs a full
 * panel debate end-to-end and persists the result to the local SQLite DB.
 *
 * Convene-specific logic: template loading, expert-spec building via
 * prompt-builder, panel + expert row insertion. The engine lifecycle
 * (init → addExpert → Debate → persist → render → cleanup) is delegated
 * to the shared `runWithEngine()` helper.
 */
import * as path from "node:path";
import { ulid } from "ulid";

import { Command } from "commander";

import { getCouncilHome, DEFAULT_MODEL } from "../../config/index.js";
import type { ContextConfig } from "../../core/debate.js";
import type { VisibilityConfig } from "../../core/context/visibility.js";
import type { DebateMode } from "../../core/template-loader.js";
import { loadTemplate, type PanelDefinition } from "../../core/template-loader.js";
import { buildSystemPrompt, type ExpertMemory } from "../../core/prompt-builder.js";
import {
  resolveStrategy,
  STRATEGY_NAMES,
} from "../strategy-resolver.js";
import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import type { HumanInputProvider } from "../../core/human-input.js";
import { createDatabase } from "../../memory/db.js";
import { recallMemory } from "../../memory/expert-memory.js";
import { ExpertRepository } from "../../memory/repositories/experts.js";
import { PanelRepository, type Panel } from "../../memory/repositories/panels.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";
import {
  ENGINE_KINDS,
  type EngineKind,
  makeEngineFromKind,
  runWithEngine,
} from "../run-with-engine.js";
import { RENDERER_FORMATS, type RendererFormat } from "../renderers/select.js";

const DEFAULT_MAX_ROUNDS = 4;
const DEFAULT_MAX_WORDS = 250;

export { ENGINE_KINDS as CONVENE_ENGINE_KINDS };
export type ConveneEngineKind = EngineKind;

export interface ConveneCommandDeps {
  readonly engineFactory?: () => CouncilEngine;
  readonly write?: Writer;
  readonly writeError?: Writer;
  /** Factory to create a HumanInputProvider. Used when --human is specified. */
  readonly humanInputFactory?: () => HumanInputProvider;
}

export interface ConveneOptions {
  readonly template: string;
  readonly format: RendererFormat;
  readonly maxRounds: number;
  readonly mode: DebateMode;
  readonly maxWords: number;
  readonly engine: EngineKind;
  readonly human?: readonly string[];
  readonly strategy?: string;
  readonly contextScope?: string;
  readonly summarizeAfter?: number;
}

/**
 * @internal Exported only so unit tests can verify wiring without
 *   instantiating sessions. Delegates to the shared helper.
 */
export { makeEngineFromKind };

export function buildConveneCommand(deps: ConveneCommandDeps = {}): Command {
  const write: Writer = deps.write ?? defaultWriter;
  const writeError: Writer = deps.writeError ?? defaultErrorWriter;

  const cmd = new Command("convene");
  cmd
    .description("Run a panel debate on a topic and persist results to the local DB")
    .argument("<topic>", "The topic / question for the panel to debate")
    .requiredOption("--template <name>", "Built-in panel template (e.g. 'code-review')")
    .requiredOption(
      "--engine <kind>",
      "Engine to use: 'mock' (offline, deterministic) or 'copilot' (real Copilot SDK)",
    )
    .option(
      "--format <kind>",
      `Output format: ${RENDERER_FORMATS.join(" | ")} (auto picks Ink TUI on TTY, plain text otherwise)`,
      "auto",
    )
    .option(
      "--max-rounds <n>",
      "Max rounds (freeform mode only)",
      (v) => Number.parseInt(v, 10),
      DEFAULT_MAX_ROUNDS,
    )
    .option("--mode <kind>", "Debate mode: freeform | structured", "freeform")
    .option(
      "--max-words <n>",
      "Soft per-response word cap",
      (v) => Number.parseInt(v, 10),
      DEFAULT_MAX_WORDS,
    )
    .option(
      "--human <name>",
      "Add a human participant by name (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--strategy <name>",
      `Moderator strategy for freeform mode (${STRATEGY_NAMES.join(" | ")}). ` +
        `devils-advocate accepts an optional ":<slug>" suffix to pin the advocate (defaults to first expert).`,
      "round-robin",
    )
    .option(
      "--context-scope <scope>",
      "Visibility scope for prior turns: all | same-round | recent (§2.6)",
      "all",
    )
    .option(
      "--summarize-after <n>",
      "Start rolling-summary after N rounds (§2.6). Omit to disable.",
      (v) => Number.parseInt(v, 10),
    )
    .action(async (topic: string, raw: ConveneOptions) => {
      if (!ENGINE_KINDS.includes(raw.engine)) {
        throw new Error(
          `Unknown --engine value: ${raw.engine}. Expected one of: ${ENGINE_KINDS.join(", ")}`,
        );
      }

      const humanNames: readonly string[] = raw.human ?? [];

      const opts: ConveneOptions = {
        template: raw.template,
        format: parseFormat(raw.format),
        maxRounds: Number.isFinite(raw.maxRounds) ? raw.maxRounds : DEFAULT_MAX_ROUNDS,
        mode: raw.mode === "structured" ? "structured" : "freeform",
        maxWords: Number.isFinite(raw.maxWords) ? raw.maxWords : DEFAULT_MAX_WORDS,
        engine: raw.engine,
        human: humanNames,
        ...(raw.strategy !== undefined ? { strategy: raw.strategy } : {}),
        ...(raw.contextScope !== undefined ? { contextScope: raw.contextScope } : {}),
        ...(raw.summarizeAfter !== undefined && Number.isFinite(raw.summarizeAfter)
          ? { summarizeAfter: raw.summarizeAfter }
          : {}),
      };

      if (opts.engine === "mock") {
        writeError(
          "\n!! [MOCK ENGINE] Running with deterministic offline mock — responses are NOT real.\n" +
            "   This debate will be persisted to the local DB tagged engine='mock'.\n\n",
        );
      }

      const template = await loadTemplate(opts.template);

      const dbPath = path.join(getCouncilHome(), "council.db");
      const db = await createDatabase(dbPath);
      try {
        const panelRepo = new PanelRepository(db);
        const expertRepo = new ExpertRepository(db);

        // Recall memory from the most recent prior panel with the same
        // template (if any) so experts continue learning across debates.
        const priorPanel = await findMostRecentPanelForTemplate(panelRepo, template.name);
        const memoryBySlug = new Map<string, ExpertMemory>();
        if (priorPanel) {
          const recalls = await Promise.all(
            template.experts.map((def) =>
              recallMemory(db, priorPanel.id, def.slug).then((mem) => [def.slug, mem] as const),
            ),
          );
          for (const [slug, mem] of recalls) {
            if (mem) memoryBySlug.set(slug, mem);
          }
        }

        const aiExperts = buildExpertSpecs(template, topic, memoryBySlug);

        // Build human expert specs from --human flags
        const humanExperts: ExpertSpec[] = humanNames.map((name) => ({
          id: ulid(),
          slug: slugify(name),
          displayName: name,
          model: "human",
          systemMessage: "(human participant)",
        }));

        const allExperts = [...aiExperts, ...humanExperts];
        const humanSlugs = new Set(humanExperts.map((e) => e.slug));

        // Resolve --strategy only for freeform mode; structured mode
        // ignores any moderator strategy by design.
        const strategy =
          opts.mode === "freeform" && opts.strategy !== undefined
            ? resolveStrategy({ raw: opts.strategy, experts: allExperts })
            : undefined;

        const contextConfig = buildContextConfig(opts);


        const panel = await panelRepo.create({
          name: `${template.name}-${new Date().toISOString().slice(0, 19)}`,
          topic,
          copilotHome: path.join(getCouncilHome(), "copilot"),
          configJson: JSON.stringify({
            template: template.name,
            mode: opts.mode,
            maxRounds: opts.maxRounds,
            maxWords: opts.maxWords,
            engine: opts.engine,
          }),
        });

        const expertSlugToId: Record<string, string> = {};
        for (const e of allExperts) {
          const row = await expertRepo.create({
            panelId: panel.id,
            slug: e.slug,
            displayName: e.displayName,
            model: e.model,
            systemMessage: e.systemMessage,
          });
          expertSlugToId[e.slug] = row.id;
        }

        await runWithEngine({
          engineKind: opts.engine,
          engineFactory: deps.engineFactory,
          experts: allExperts,
          debateConfig: {
            maxRounds: opts.maxRounds,
            maxWordsPerResponse: opts.maxWords,
            mode: opts.mode,
            ...(strategy !== undefined ? { strategy } : {}),
            ...(contextConfig !== undefined ? { contextConfig } : {}),
          },
          prompt: topic,
          panelId: panel.id,
          expertSlugToId,
          moderator:
            opts.mode === "structured"
              ? "structured-phases"
              : (strategy?.name ?? "round-robin"),
          format: opts.format,
          write,
          writeError,
          db,
          humanSlugs: humanSlugs.size > 0 ? humanSlugs : undefined,
          humanInput: humanSlugs.size > 0 ? deps.humanInputFactory?.() : undefined,
          preamble: () => {
            write(`\n# ${template.name}\n`);
            write(`Topic: ${topic}\n`);
            write(`Mode: ${opts.mode} | Max rounds: ${opts.maxRounds} | Engine: ${opts.engine}\n`);
            if (humanNames.length > 0) {
              write(`Human participants: ${humanNames.join(", ")}\n`);
            }
            write("\n");
          },
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

function parseFormat(raw: string | undefined): RendererFormat {
  if (raw === undefined) return "auto";
  if ((RENDERER_FORMATS as readonly string[]).includes(raw)) {
    return raw as RendererFormat;
  }
  throw new Error(
    `Unknown --format value: ${raw}. Expected one of: ${RENDERER_FORMATS.join(", ")}`,
  );
}

function buildExpertSpecs(
  template: PanelDefinition,
  topic: string,
  memoryBySlug: ReadonlyMap<string, ExpertMemory>,
): ExpertSpec[] {
  return template.experts.map((def) => {
    const systemMessage = buildSystemPrompt(def, memoryBySlug.get(def.slug), topic);
    return {
      id: ulid(),
      slug: def.slug,
      displayName: def.displayName,
      model: def.model ?? DEFAULT_MODEL,
      systemMessage,
    };
  });
}

/**
 * Find the most recently-created panel whose stored config has the same
 * `template` name. Used to bridge per-debate memory: each `convene` run
 * creates a new panel, but experts of the same template should remember
 * what was said before.
 *
 * Returns undefined when no prior panel is found or when configJson is
 * malformed for every candidate.
 */
async function findMostRecentPanelForTemplate(
  panelRepo: PanelRepository,
  templateName: string,
): Promise<Panel | undefined> {
  const all = await panelRepo.findAll();
  const matches = all.filter((p) => {
    try {
      const cfg = JSON.parse(p.configJson) as { template?: unknown };
      return cfg.template === templateName;
    } catch {
      return false;
    }
  });
  if (matches.length === 0) return undefined;
  // Most-recent by createdAt (ISO-8601 — lexically sortable).
  matches.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return matches[0];
}

/** Convert a display name like "Product Lead" to a slug like "product-lead". */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const VALID_CONTEXT_SCOPES = ["all", "same-round", "recent"] as const;

function buildContextConfig(opts: ConveneOptions): ContextConfig | undefined {
  const visibility =
    opts.contextScope !== undefined && opts.contextScope !== "all"
      ? parseContextScope(opts.contextScope)
      : undefined;
  const summarizer =
    opts.summarizeAfter !== undefined
      ? { summarizeAfterRound: opts.summarizeAfter, maxSummaryLength: 500 }
      : undefined;
  if (visibility === undefined && summarizer === undefined) return undefined;
  return {
    ...(visibility !== undefined ? { visibility } : {}),
    ...(summarizer !== undefined ? { summarizer } : {}),
  };
}

function parseContextScope(raw: string): VisibilityConfig {
  if (!(VALID_CONTEXT_SCOPES as readonly string[]).includes(raw)) {
    throw new Error(
      `Unknown --context-scope value: ${raw}. Expected one of: ${VALID_CONTEXT_SCOPES.join(", ")}`,
    );
  }
  return { scope: raw as (typeof VALID_CONTEXT_SCOPES)[number] };
}
