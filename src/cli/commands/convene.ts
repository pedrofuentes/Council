/**
 * `council convene <topic> [--template <name>] --engine <kind>` — runs a full
 * panel debate end-to-end and persists the result to the local SQLite DB.
 *
 * `--template` is optional: when omitted, convene auto-composes a panel from
 * the topic via the LLM meta-prompt (see `src/core/auto-compose.ts`).
 *
 * Convene-specific logic: template loading, expert-spec building via
 * prompt-builder, panel + expert row insertion. The engine lifecycle
 * (init → addExpert → Debate → persist → render → cleanup) is delegated
 * to the shared `runWithEngine()` helper.
 */
import * as path from "node:path";
import { ulid } from "ulid";

import { Command } from "commander";

import { CliUserError } from "../cli-user-error.js";

import { autoComposePanel } from "../../core/auto-compose.js";
import { getCouncilDataHome, getCouncilHome, loadConfig } from "../../config/index.js";
import type { ContextConfig } from "../../core/debate.js";
import type { VisibilityConfig } from "../../core/context/visibility.js";
import { FileExpertLibrary } from "../../core/expert-library.js";
import { isMigrationNeeded, migrateBuiltInTemplates } from "../../core/template-migration.js";
import { resolveModel } from "../../core/model-resolver.js";
import type { DebateMode } from "../../core/template-loader.js";
import {
  assertAllInline,
  loadPanel,
  resolveExperts,
  type ResolvedPanelDefinition,
} from "../../core/template-loader.js";
import { buildSystemPrompt, type ExpertMemory } from "../../core/prompt-builder.js";
import { resolveStrategy, STRATEGY_NAMES } from "../strategy-resolver.js";
import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import type { HumanInputProvider } from "../../core/human-input.js";
import { createDatabase } from "../../memory/db.js";
import { recallMemory } from "../../memory/expert-memory.js";
import { ExpertRepository } from "../../memory/repositories/experts.js";
import { PanelRepository, type Panel } from "../../memory/repositories/panels.js";

import { runExtractMemoryHook } from "../extract-memory-hook.js";

import { stripControlChars } from "../strip-control-chars.js";
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

/**
 * Prompts the user to confirm an action and resolves with their choice.
 * Used to gate the auto-composed panel behind explicit confirmation so
 * that an unexpected meta-prompt result cannot silently start a real
 * (premium-request-consuming) debate.
 */
export interface ConfirmProvider {
  confirm(message: string): Promise<boolean>;
}

export interface ConveneCommandDeps {
  readonly engineFactory?: () => CouncilEngine;
  readonly write?: Writer;
  readonly writeError?: Writer;
  /** Factory to create a HumanInputProvider. Used when --human is specified. */
  readonly humanInputFactory?: () => HumanInputProvider;
  /**
   * Factory to create a ConfirmProvider for the auto-compose
   * confirmation prompt. When omitted, a readline-backed default is
   * used that reads from stdin/stdout.
   */
  readonly confirmProvider?: () => ConfirmProvider;
}

export interface ConveneOptions {
  readonly template?: string | undefined;
  readonly format: RendererFormat;
  readonly maxRounds: number;
  readonly mode: DebateMode;
  readonly maxWords: number;
  readonly engine: EngineKind;
  readonly human?: readonly string[];
  readonly strategy?: string;
  readonly contextScope?: string;
  readonly summarizeAfter?: number;
  readonly heuristicSummaries?: boolean;
  readonly heuristicMemory?: boolean;
  readonly yes?: boolean;
}

/**
 * Narrow shape consumed by {@link buildContextConfig} — exported so unit
 * tests can probe summarizer-mode wiring without instantiating the full
 * Commander pipeline.
 */
export interface SummarizerOptions {
  readonly contextScope?: string;
  readonly summarizeAfter?: number;
  readonly heuristicSummaries?: boolean;
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
    .option(
      "--template <name>",
      "Built-in panel template (e.g. 'code-review'). If omitted, the panel is auto-composed from the topic.",
    )
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
    .option(
      "--heuristic-summaries",
      "Use the cheap heuristic summarizer instead of the default LLM-backed one (§2.6)",
    )
    .option(
      "--heuristic-memory",
      "Skip the post-debate LLM extraction pass and rely on the heuristic recall scan (§3.1). " +
        "Useful for offline tests and air-gapped environments.",
    )
    .option("--yes", "Skip the auto-compose confirmation prompt (non-interactive runs)")
    .action(async (topic: string, raw: ConveneOptions) => {
      if (!ENGINE_KINDS.includes(raw.engine)) {
        throw new Error(
          `Unknown --engine value: ${raw.engine}. Expected one of: ${ENGINE_KINDS.join(", ")}`,
        );
      }

      const config = await loadConfig();
      const defaultModel = config.defaults.model;
      const humanNames: readonly string[] = raw.human ?? [];

      const opts: ConveneOptions = {
        template: raw.template,
        format: parseFormat(raw.format),
        maxRounds: Number.isFinite(raw.maxRounds) ? raw.maxRounds : DEFAULT_MAX_ROUNDS,
        mode: raw.mode === "structured" ? "structured" : "freeform",
        maxWords: Number.isFinite(raw.maxWords) ? raw.maxWords : DEFAULT_MAX_WORDS,
        engine: raw.engine,
        human: humanNames,
        yes: raw.yes === true,
        heuristicSummaries: raw.heuristicSummaries === true,
        heuristicMemory: raw.heuristicMemory === true,
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

      let template: ResolvedPanelDefinition;
      if (opts.template) {
        // User panels in <dataHome>/panels/ override built-in templates.
        // If the chosen panel references library experts by slug, resolve
        // them via the expert library before handing off to the engine.
        const dataHome = getCouncilDataHome();
        const libDbPath = path.join(getCouncilHome(), "council.db");

        // First-run (and DB-reset) hook: if the user has never migrated —
        // or the DB has been reset but on-disk YAMLs remain — extract the
        // built-in panels' inline experts into <dataHome>/experts/ and
        // rewrite the panels in <dataHome>/panels/ to reference them by
        // slug, plus (re-)register library DB rows. Idempotent.
        const migDb = await createDatabase(libDbPath);
        try {
          if (await isMigrationNeeded(dataHome, migDb)) {
            const migLib = new FileExpertLibrary(dataHome, migDb);
            await migrateBuiltInTemplates(dataHome, migLib, migDb);
          }
        } finally {
          await migDb.destroy();
        }

        const panel = await loadPanel(opts.template, dataHome);
        const hasSlugRefs = panel.experts.some((e) => typeof e === "string");
        if (!hasSlugRefs) {
          template = assertAllInline(panel, opts.template);
        } else {
          const libDb = await createDatabase(libDbPath);
          try {
            const library = new FileExpertLibrary(dataHome, libDb);
            const { resolved, missing } = await resolveExperts(panel.experts, library);
            if (missing.length > 0) {
              throw new Error(
                `Panel "${stripControlChars(opts.template)}" references experts not in the library: ${missing.map((s) => stripControlChars(s)).join(", ")}. ` +
                  `Add them with 'council expert create' or use inline expert definitions.`,
              );
            }
            template = {
              name: panel.name,
              ...(panel.description !== undefined ? { description: panel.description } : {}),
              ...(panel.defaults !== undefined ? { defaults: panel.defaults } : {}),
              experts: resolved,
            };
          } finally {
            await libDb.destroy();
          }
        }
      } else {
        // §2.5 auto-compose: spin up a temporary engine session, ask the
        // composer to design the panel, then tear it down. The real debate
        // gets its own engine instance via runWithEngine() below.
        const composeEngine = deps.engineFactory
          ? deps.engineFactory()
          : makeEngineFromKind(opts.engine);
        try {
          await composeEngine.start();
          try {
            template = await autoComposePanel(topic, composeEngine, {
              defaultModel,
            });
          } catch (err: unknown) {
            const cause = err instanceof Error ? err.message : String(err);
            throw new Error(
              `Could not auto-compose a panel for this topic. Use --template to specify one manually. (cause: ${cause})`,
            );
          }
        } finally {
          await composeEngine.stop().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            writeError(`!! engine.stop() failed during auto-compose cleanup: ${msg}\n`);
          });
        }
        writeError(`\n🏛️  Auto-composed panel: ${stripControlChars(template.name)}\n`);
        for (const expert of template.experts) {
          writeError(
            `  • ${stripControlChars(expert.displayName)} — ${stripControlChars(expert.role)}\n`,
          );
        }
        writeError("\n");

        // Confirmation gate — auto-composed panels are LLM-generated and may
        // not match user intent. Block the debate behind explicit consent
        // unless --yes was passed for non-interactive runs.
        if (opts.yes !== true) {
          const provider = deps.confirmProvider
            ? deps.confirmProvider()
            : createReadlineConfirmProvider();
          const ok = await provider.confirm("Proceed with this panel? [y/N] ");
          if (!ok) {
            writeError("Aborted. Use --template to specify a panel manually.\n");
            throw new CliUserError("Aborted: auto-composed panel was not confirmed.");
          }
        }
      }

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

        const aiExperts = buildExpertSpecs(template, topic, memoryBySlug, defaultModel);

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
            opts.mode === "structured" ? "structured-phases" : (strategy?.name ?? "round-robin"),
          format: opts.format,
          write,
          writeError,
          db,
          humanSlugs: humanSlugs.size > 0 ? humanSlugs : undefined,
          humanInput: humanSlugs.size > 0 ? deps.humanInputFactory?.() : undefined,
          preamble: () => {
            write(`\n# ${stripControlChars(template.name)}\n`);
            write(`Topic: ${topic}\n`);
            write(`Mode: ${opts.mode} | Max rounds: ${opts.maxRounds} | Engine: ${opts.engine}\n`);
            if (humanNames.length > 0) {
              write(`Human participants: ${humanNames.join(", ")}\n`);
            }
            write("\n");
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
                    humanSlugs,
                    model: defaultModel,
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
  template: ResolvedPanelDefinition,
  topic: string,
  memoryBySlug: ReadonlyMap<string, ExpertMemory>,
  configDefaultModel: string,
): ExpertSpec[] {
  return template.experts.map((def) => {
    const systemMessage = buildSystemPrompt(def, memoryBySlug.get(def.slug), topic);
    return {
      id: ulid(),
      slug: def.slug,
      displayName: def.displayName,
      model: resolveModel({ expertModel: def.model, configDefaultModel }),
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
  // Filter to same template AND non-mock engine. Mock-engine panels are
  // explicitly excluded (Sentinel pr222 cycle 3 #1 🔴) — their turns are
  // deterministic offline placeholders that would contaminate later real
  // (--engine copilot) debates with fabricated "memory" if they were
  // recalled. A panel without an engine field is treated as non-mock for
  // backward compatibility with rows written before the engine field
  // existed.
  const matches = all.filter((p) => {
    try {
      const cfg = JSON.parse(p.configJson) as { template?: unknown; engine?: unknown };
      return cfg.template === templateName && cfg.engine !== "mock";
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

/**
 * Translate parsed CLI options into a {@link ContextConfig}. Exported
 * so unit tests can probe the summarizer-mode wiring without running
 * the full Commander pipeline.
 *
 * Defaults — when `--summarize-after` is set:
 *   - mode: "llm" (engine-backed, higher quality)
 *   - mode: "heuristic" if `--heuristic-summaries` is also passed.
 */
export function buildContextConfig(opts: SummarizerOptions): ContextConfig | undefined {
  const visibility =
    opts.contextScope !== undefined && opts.contextScope !== "all"
      ? parseContextScope(opts.contextScope)
      : undefined;
  const summarizer =
    opts.summarizeAfter !== undefined
      ? {
          summarizeAfterRound: opts.summarizeAfter,
          maxSummaryLength: 500,
          mode: (opts.heuristicSummaries === true ? "heuristic" : "llm") as "heuristic" | "llm",
        }
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

/**
 * Default {@link ConfirmProvider} backed by Node's `readline`. Reads
 * a single line from stdin and resolves true only when the user typed
 * `y` or `yes` (case-insensitive). Anything else — including an empty
 * line or EOF — resolves false (the safer default for a prompt the user
 * may have missed entirely).
 */
function createReadlineConfirmProvider(): ConfirmProvider {
  return {
    async confirm(message: string): Promise<boolean> {
      const readline = await import("node:readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const answer = await new Promise<string>((resolve) => {
          rl.question(message, (a) => resolve(a));
        });
        const normalized = answer.trim().toLowerCase();
        return normalized === "y" || normalized === "yes";
      } finally {
        rl.close();
      }
    },
  };
}
