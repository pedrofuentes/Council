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

import { Command, Option } from "commander";

import { CliUserError } from "../cli-user-error.js";

import { autoComposePanel } from "../../core/auto-compose.js";
import { checkTopicAdmission } from "../../core/topic-admission.js";
import {
  getCouncilDataHome,
  getCouncilHome,
  loadConfig,
  resolveEngine,
} from "../../config/index.js";
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
import { ExpertRepository } from "../../memory/repositories/experts.js";
import { PanelRepository } from "../../memory/repositories/panels.js";

import { runExtractMemoryHook } from "../extract-memory-hook.js";

import { stripControlChars } from "../strip-control-chars.js";
import { defaultErrorWriter, defaultWriter, isQuiet, type Writer } from "./writer.js";
import {
  ENGINE_KINDS,
  type EngineKind,
  makeEngineFromKind,
  runWithEngine,
} from "../run-with-engine.js";
import { RENDERER_FORMATS, type RendererFormat } from "../renderers/select.js";
import { createReadlineConfirmProvider, type ConfirmProvider } from "./confirm.js";
import { isNonInteractive } from "../non-interactive.js";

const DEFAULT_MAX_ROUNDS = 4;
const DEFAULT_MAX_WORDS = 250;

export { ENGINE_KINDS as CONVENE_ENGINE_KINDS };
export type ConveneEngineKind = EngineKind;

export type { ConfirmProvider } from "./confirm.js";

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
  /**
   * Subscribe to SIGINT (Ctrl+C). Returns an unsubscribe function.
   * When omitted, a default implementation that calls `process.on`
   * is used. Tests inject a stub to simulate interrupts deterministically
   * without affecting the host process (issue #T6).
   */
  readonly subscribeInterrupt?: (handler: () => void) => () => void;
}

export interface ConveneOptions {
  readonly template?: string | undefined;
  readonly panel?: string | undefined;
  readonly experts?: string | undefined;
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
  readonly verbose?: boolean;
  readonly model?: string;
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
    .description(
      "Run a panel debate on a topic and persist results to the local DB. " +
        "For one-shot questions use `council ask`. For conversation use `council chat`.",
    )
    .argument("<topic>", "The topic / question for the panel to debate")
    .option(
      "-p, --panel <name>",
      "Use a built-in or custom panel template (alias: --template). **Omit to let Council auto-design an expert panel from your topic.**",
    )
    .option(
      "--template <name>",
      "Use a built-in or custom panel template (alias: --panel). **Omit to let Council auto-design an expert panel from your topic.**",
    )
    .option(
      "--experts <slugs>",
      "Comma-separated expert slugs from the library. Bypasses both --template and auto-compose.",
    )
    .addOption(
      new Option("--engine <kind>", "Engine to use (default: from config)").choices([
        ...ENGINE_KINDS,
      ]),
    )
    .addOption(
      new Option(
        "--format <kind>",
        "Output format (auto picks Ink TUI on TTY, plain text otherwise)",
      )
        .choices([...RENDERER_FORMATS])
        .default("auto"),
    )
    .option(
      "--max-rounds <n>",
      "Max rounds (freeform mode only)",
      (v) => Number.parseInt(v, 10),
      DEFAULT_MAX_ROUNDS,
    )
    .addOption(
      new Option("--mode <kind>", "Debate mode")
        .choices(["freeform", "structured"])
        .default("freeform"),
    )
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
      "Visibility scope for prior turns: all | same-round | recent",
      "all",
    )
    .option(
      "--summarize-after <n>",
      "Start rolling-summary after N rounds. Omit to disable.",
      (v) => Number.parseInt(v, 10),
    )
    .option(
      "--heuristic-summaries",
      "Use simpler local summarizer instead of LLM — for offline/air-gapped use",
    )
    .option(
      "--heuristic-memory",
      "Skip post-debate LLM extraction — for offline/air-gapped use. " +
        "Useful for offline tests and air-gapped environments.",
    )
    .option("--yes", "Skip the auto-compose confirmation prompt (non-interactive runs)")
    .option("--verbose", "Show migration summaries even when no items changed")
    .option("--model <model>", "Model to use for experts (default: from config)")
    .action(async (topic: string, raw: ConveneOptions) => {
      const admission = checkTopicAdmission(topic);
      for (const warning of admission.warnings) {
        writeError(warning + "\n");
      }

      const config = await loadConfig();
      const defaultModel = raw.model ?? config.defaults.model;
      const resolvedEngine = resolveEngine(raw.engine, config);
      const humanNames: readonly string[] = raw.human ?? [];
      const writeInformationalNotice = (message: string): void => {
        if (!isQuiet()) {
          writeError(message);
        }
      };
      let mockWarningEmitted = false;
      const emitMockWarning = (): void => {
        if (mockWarningEmitted || resolvedEngine !== "mock" || isQuiet()) {
          return;
        }
        mockWarningEmitted = true;
        writeError(
          "\n!! [MOCK ENGINE] Running with deterministic offline mock — responses are NOT real.\n" +
            "   This debate will be persisted to the local DB tagged engine='mock'.\n\n",
        );
      };

      // Accept both --panel and --template (aliases)
      const templateName = raw.panel ?? raw.template;

      if (raw.experts !== undefined && templateName !== undefined) {
        throw new CliUserError(
          "Cannot use --experts together with --template/--panel. Pass one or the other.",
        );
      }

      const opts: ConveneOptions = {
        template: templateName,
        ...(raw.experts !== undefined ? { experts: raw.experts } : {}),
        format: parseFormat(raw.format),
        maxRounds: Number.isFinite(raw.maxRounds) ? raw.maxRounds : DEFAULT_MAX_ROUNDS,
        mode: raw.mode === "structured" ? "structured" : "freeform",
        maxWords: Number.isFinite(raw.maxWords) ? raw.maxWords : DEFAULT_MAX_WORDS,
        engine: resolvedEngine,
        human: humanNames,
        yes: raw.yes === true,
        heuristicSummaries: raw.heuristicSummaries === true,
        heuristicMemory: raw.heuristicMemory === true,
        verbose: raw.verbose === true,
        ...(raw.strategy !== undefined ? { strategy: raw.strategy } : {}),
        ...(raw.contextScope !== undefined ? { contextScope: raw.contextScope } : {}),
        ...(raw.summarizeAfter !== undefined && Number.isFinite(raw.summarizeAfter)
          ? { summarizeAfter: raw.summarizeAfter }
          : {}),
      };

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
          const shouldRunMigration =
            opts.verbose === true || (await isMigrationNeeded(dataHome, migDb));
          if (shouldRunMigration) {
            const migLib = new FileExpertLibrary(dataHome, migDb);
            await migrateBuiltInTemplates(dataHome, migLib, migDb, {
              quiet: isQuiet(),
              verbose: opts.verbose === true,
              writeNotice: (message) => {
                writeError(message);
              },
            });
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
      } else if (opts.experts !== undefined) {
        // F31: --experts loads expert slugs directly from the library,
        // skipping both template loading and auto-compose.
        const dataHome = getCouncilDataHome();
        const libDbPath = path.join(getCouncilHome(), "council.db");
        const expertSlugs = opts.experts
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (expertSlugs.length === 0) {
          throw new CliUserError("--experts requires at least one expert slug.");
        }
        const libDb = await createDatabase(libDbPath);
        try {
          const library = new FileExpertLibrary(dataHome, libDb);
          const { resolved, missing } = await resolveExperts(expertSlugs, library);
          if (missing.length > 0) {
            throw new CliUserError(
              `--experts references experts not in the library: ${missing
                .map((s) => stripControlChars(s))
                .join(", ")}. Add them with 'council expert create'.`,
            );
          }
          template = {
            name: "ad-hoc",
            experts: resolved,
          };
        } finally {
          await libDb.destroy();
        }
      } else {
        // §2.5 auto-compose: spin up a temporary engine session, ask the
        // composer to design the panel, then tear it down. The real debate
        // gets its own engine instance via runWithEngine() below.
        emitMockWarning();
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
        writeInformationalNotice(`\n🏛️  Auto-composed panel: ${stripControlChars(template.name)}\n`);
        for (const expert of template.experts) {
          writeInformationalNotice(
            `  • ${stripControlChars(expert.displayName)} — ${stripControlChars(expert.role)}\n`,
          );
        }
        writeInformationalNotice("\n");

        // Confirmation gate — auto-composed panels are LLM-generated and may
        // not match user intent. Three branches:
        //   1. Custom confirmProvider (tests/plugins) — always call it.
        //   2. Non-TTY (CI/piped) — error, require --yes to proceed.
        //   3. Interactive TTY — readline prompt, abort if declined.
        if (opts.yes !== true) {
          if (deps.confirmProvider) {
            // Custom provider injected (tests or plugins) — always use it.
            const provider = deps.confirmProvider();
            const ok = await provider.confirm("Proceed with this panel? [y/N] ");
            if (!ok) {
              writeError("Aborted. Use --template to specify a panel manually.\n");
              throw new CliUserError("Aborted: auto-composed panel was not confirmed.");
            }
          } else if (isNonInteractive()) {
            throw new CliUserError(
              "Non-interactive shell detected. Auto-compose requires --yes in non-interactive mode.",
            );
          } else {
            const provider = createReadlineConfirmProvider();
            const ok = await provider.confirm("Proceed with this panel? [y/N] ");
            if (!ok) {
              writeError("Aborted. Use --template to specify a panel manually.\n");
              throw new CliUserError("Aborted: auto-composed panel was not confirmed.");
            }
          }
        }
      }

      const dbPath = path.join(getCouncilHome(), "council.db");
      const db = await createDatabase(dbPath);
      try {
        const panelRepo = new PanelRepository(db);
        const expertRepo = new ExpertRepository(db);

        // T1 (context-bleed fix): a fresh `convene` invocation starts a
        // brand-new debate and MUST NOT inject memory from any prior
        // same-template panel. Loading prior memory into expert system
        // prompts caused round 2+ of new debates to bleed content from
        // earlier (unrelated) debates — the #1 trust-destroying bug.
        //
        // Memory is still EXTRACTED post-debate (see runExtractMemoryHook
        // below) so it remains available to `resume`, which intentionally
        // continues a prior debate's context.
        const memoryBySlug = new Map<string, ExpertMemory>();

        const aiExperts = buildExpertSpecs(
          template,
          topic,
          memoryBySlug,
          template.defaults?.model,
          defaultModel,
        );

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

        // T6: wire Ctrl+C (SIGINT) to gracefully abort the debate.
        // The signal is forwarded through runWithEngine to Debate.run,
        // which stops at the next turn boundary and emits a terminal
        // debate.end event with reason: "aborted". DebatePersister then
        // flushes any buffered deltas as a partial turn and marks the
        // persisted debate row `interrupted`, so resume can auto-continue.
        //
        // Lifecycle invariants (Sentinel pr769 findings 1 & 2):
        //   1. The handler is registered BEFORE any setup that can
        //      throw (panel/expert row inserts) and unsubscribed in a
        //      `finally` that wraps the entire setup-and-run block.
        //      This prevents a stale process-level listener if setup
        //      fails before runWithEngine starts.
        //   2. The handler unsubscribes ITSELF first so a second Ctrl+C
        //      hits Node's default SIGINT behavior (process kill)
        //      immediately, even while the first abort is still
        //      unwinding the debate loop.
        const debateController = new AbortController();
        let debateInterrupted = false;
        // Holder so onInterrupt can capture the unsubscribe function
        // that is assigned right below. `process.off` is idempotent,
        // so it's safe if the outer `finally` also calls it.
        let unsubscribeInterrupt: () => void = () => undefined;
        const onInterrupt = (): void => {
          debateInterrupted = true;
          unsubscribeInterrupt();
          debateController.abort();
        };
        const subscribeInterrupt = deps.subscribeInterrupt ?? defaultSubscribeInterrupt;
        unsubscribeInterrupt = subscribeInterrupt(onInterrupt);

        try {
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
            signal: debateController.signal,
            humanSlugs: humanSlugs.size > 0 ? humanSlugs : undefined,
            humanInput: humanSlugs.size > 0 ? deps.humanInputFactory?.() : undefined,
            beforeRender: emitMockWarning,
            preamble: () => {
              write(`\n# ${stripControlChars(template.name)}\n`);
              write(`Topic: ${topic}\n`);
              write(
                `Mode: ${opts.mode} | Max rounds: ${opts.maxRounds} | Engine: ${opts.engine}\n`,
              );
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
  $ council convene "Should we adopt GraphQL?" --engine copilot
  $ council convene "Review this PR" --template code-review --engine copilot
  $ council convene "Ship now or wait?" --mode structured --engine copilot

Shell quoting: bash and PowerShell both expand $variables inside double quotes.
Wrap topics containing $, !, or backticks in SINGLE quotes to keep them literal:
  bash       $ council convene 'Is $450/hr reasonable?' --engine copilot
  PowerShell > council convene 'Is $450/hr reasonable?' --engine copilot
`,
  );

  // CLI-05: Help tiering — separate common vs advanced flags
  const COMMON_FLAGS = new Set(["--template", "--engine", "--format", "--max-rounds", "--yes"]);

  cmd.configureHelp({
    formatHelp: (command, helper) => {
      const termWidth = helper.padWidth(command, helper);
      const sections: string[] = [];

      sections.push(`Usage: ${helper.commandUsage(command)}`);
      sections.push("");
      sections.push(helper.commandDescription(command));
      sections.push("");

      const commonOpts = command.options.filter((o) => COMMON_FLAGS.has(o.long ?? ""));
      const advancedOpts = command.options.filter((o) => !COMMON_FLAGS.has(o.long ?? ""));

      if (commonOpts.length > 0) {
        sections.push("Common Options:");
        for (const opt of commonOpts) {
          sections.push(
            `  ${helper.optionTerm(opt).padEnd(termWidth)}  ${helper.optionDescription(opt)}`,
          );
        }
        sections.push("");
      }

      if (advancedOpts.length > 0) {
        sections.push("Advanced Options:");
        for (const opt of advancedOpts) {
          sections.push(
            `  ${helper.optionTerm(opt).padEnd(termWidth)}  ${helper.optionDescription(opt)}`,
          );
        }
        sections.push("");
      }

      return sections.join("\n");
    },
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
  panelDefaultModel: string | undefined,
  configDefaultModel: string,
): ExpertSpec[] {
  return template.experts.map((def) => {
    const systemMessage = buildSystemPrompt(def, memoryBySlug.get(def.slug), topic);
    return {
      id: ulid(),
      slug: def.slug,
      displayName: def.displayName,
      model: resolveModel({ expertModel: def.model, panelDefaultModel, configDefaultModel }),
      systemMessage,
    };
  });
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
 * Default {@link ConveneCommandDeps.subscribeInterrupt} implementation:
 * register the handler on `process.on("SIGINT", ...)` and return an
 * unsubscribe that removes it. Tests inject a custom subscriber so
 * the host process's signal handlers are unaffected (#T6).
 */
function defaultSubscribeInterrupt(handler: () => void): () => void {
  process.on("SIGINT", handler);
  return () => {
    process.off("SIGINT", handler);
  };
}
