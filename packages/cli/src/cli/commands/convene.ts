/**
 * `council convene [topic] [--template <name>] --engine <kind>` — runs a full
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
import { parseExpertSlugs, warnOnStrayExpertArgs } from "./expert-args.js";

import { autoComposePanel } from "../../core/auto-compose.js";
import { allowlistExpertDefinition, type ExpertDefinition } from "../../core/expert.js";
import {
  checkTopicAdmission,
  detectShellExpansion,
  type TopicSource,
} from "../../core/topic-admission.js";
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
import { createDocumentRetriever, type DocumentSnippet } from "../../core/documents/retriever.js";
import {
  capSnippetsByChars,
  REFERENCE_DOCS_CHAR_CAP,
} from "../../core/documents/reference-block.js";
import { resolveStrategy, STRATEGY_NAMES } from "../strategy-resolver.js";
import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import { isSupportedModel, SUPPORTED_MODELS } from "../../engine/models.js";
import type { HumanInputProvider } from "../../core/human-input.js";
import { createDatabase } from "../../memory/db.js";
import { ExpertRepository } from "../../memory/repositories/experts.js";
import { PanelRepository } from "../../memory/repositories/panels.js";
import { loadTranscript } from "../../memory/transcript.js";

import { runExtractMemoryHook } from "../extract-memory-hook.js";

import { toSingleLineDisplay } from "../strip-control-chars.js";
import { suggestMatch } from "../fuzzy-match.js";
import { truncatePrompt } from "../renderers/truncate-prompt.js";
import { defaultErrorWriter, defaultWriter, isQuiet, setQuiet, type Writer } from "./writer.js";
import {
  ENGINE_KINDS,
  type EngineKind,
  makeEngineFromKind,
  runWithEngine,
} from "../run-with-engine.js";
import { RENDERER_FORMATS, type RendererFormat } from "../renderers/select.js";
import { createReadlineConfirmProvider, type ConfirmProvider } from "./confirm.js";
import { isNonInteractive } from "../non-interactive.js";
import { promptForTopic } from "../interactive-topic-input.js";
import { readTextInput } from "../read-text-input.js";
import { createProgress } from "../progress.js";
import {
  renderPlain as renderConclusionPlain,
  synthesizeConclusion,
} from "../conclusion-synthesis.js";

const DEFAULT_MAX_ROUNDS = 4;
const DEFAULT_MAX_WORDS = 250;

export { ENGINE_KINDS as CONVENE_ENGINE_KINDS };
export type ConveneEngineKind = EngineKind;

export type { ConfirmProvider } from "./confirm.js";

/**
 * Build the EXPLICIT, allowlisted panel definition object that is persisted
 * into a session's `config_json.definition`. Rather than serializing the
 * whole {@link ResolvedPanelDefinition} (which may carry resolver-internal or
 * otherwise unexpected properties), we copy ONLY the fields that the
 * `panel save` / chat resolve path re-reads (see `StoredPanelDefinitionSchema`
 * in `panel.ts`). Each expert is run through {@link allowlistExpertDefinition}
 * so the stored shape stays fully re-resolvable (round-trip integrity).
 */
export function buildPersistedPanelDefinition(template: ResolvedPanelDefinition): {
  readonly name: string;
  readonly description?: string;
  readonly defaults?: ResolvedPanelDefinition["defaults"];
  readonly experts: readonly ExpertDefinition[];
} {
  return {
    name: template.name,
    ...(template.description !== undefined ? { description: template.description } : {}),
    ...(template.defaults !== undefined ? { defaults: template.defaults } : {}),
    experts: template.experts.map((e) => allowlistExpertDefinition(e)),
  };
}

/**
 * Render the post-debate hint that points the user at `council panel save`.
 * The session name is AI-derived and may contain terminal control sequences,
 * so it is sanitized via {@link toSingleLineDisplay} before being written to
 * this single-line terminal sink.
 */
export function formatPanelSaveHint(sessionName: string): string {
  return `Tip: Liked this panel? Save it to your library to reuse it: council panel save ${toSingleLineDisplay(
    sessionName,
  )} [name]\n`;
}

/**
 * Format the best-effort RAG retrieval-failure warning. The raw error
 * message originates from the document retriever / SQLite layer and is
 * untrusted: it may span multiple lines, embed terminal control sequences,
 * or leak unbounded internal detail. Mirroring chat's bounded
 * `sanitizeErrorMessage`, collapse it to a single line via
 * {@link toSingleLineDisplay} and cap its length via {@link truncatePrompt}
 * before it reaches stderr.
 */
export function formatRetrievalFailureWarning(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return `!! document retrieval failed (continuing without reference docs): ${truncatePrompt(
    toSingleLineDisplay(raw),
  )}\n`;
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
  /**
   * Factory to create a ConfirmProvider for the shell-expansion
   * confirm-on-detect prompt (PM-02). Kept separate from
   * {@link confirmProvider} so the two prompts can be exercised
   * independently in tests. When omitted, a readline-backed default is
   * used (gated by {@link isNonInteractive}).
   */
  readonly topicConfirmProvider?: () => ConfirmProvider;
  /**
   * Provider for interactive topic input when no positional topic or
   * --prompt-file is supplied.
   */
  readonly topicInputProvider?: () => Promise<string>;
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
  readonly promptFile?: string | undefined;
  readonly experts?: string | readonly string[] | undefined;
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
  readonly quiet?: boolean;
  readonly model?: string;
  readonly maxExperts?: number;
  readonly conclude?: boolean;
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
    .argument(
      "[topic]",
      "The topic / question for the panel to debate (optional when --prompt-file is used; omit in a terminal to enter it interactively)",
    )
    // Keep stray operands instead of erroring so warnOnStrayExpertArgs can flag
    // bare slugs passed without --experts (e.g. PowerShell splitting --experts a,b,c).
    .allowExcessArguments()
    .option(
      "--prompt-file <path>",
      "Read the topic VERBATIM from a file (or `-` for stdin) instead of the positional argument. " +
        "Bypasses the shell so `$`, backticks, and values like `$180K` survive intact. " +
        "Mutually exclusive with the positional <topic>.",
    )
    .option(
      "-p, --panel <name>",
      "Use a built-in or custom panel template (alias: --template). **Omit to let Council auto-design an expert panel from your topic.**",
    )
    .option(
      "--template <name>",
      "Use a built-in or custom panel template (alias: --panel). **Omit to let Council auto-design an expert panel from your topic.**",
    )
    .option(
      "--experts <slugs...>",
      "Expert slugs from the library (space- or comma-separated, repeatable). Bypasses both --template and auto-compose.",
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
      (v) => {
        const parsed = Number(v);
        if (!Number.isInteger(parsed)) {
          throw new Error(`--max-rounds must be an integer (got: ${v})`);
        }
        return parsed;
      },
      DEFAULT_MAX_ROUNDS,
    )
    .addOption(
      new Option("--mode <kind>", "Debate mode")
        .choices(["freeform", "structured"])
        .default("freeform"),
    )
    .option(
      "--max-words <n>",
      "Soft per-response word budget (opening-phase anchor; structured mode scales the other phases)",
      (v) => {
        const parsed = Number(v);
        if (!Number.isInteger(parsed)) {
          throw new Error(`--max-words must be an integer (got: ${v})`);
        }
        return parsed;
      },
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
      (v) => {
        const parsed = Number(v);
        if (!Number.isInteger(parsed)) {
          throw new Error(`--summarize-after must be an integer (got: ${v})`);
        }
        return parsed;
      },
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
    .option(
      "--yes",
      "Skip the auto-compose confirmation prompt — required for non-interactive / CI runs",
    )
    .option("--no-conclude", "Skip automatic conclusion synthesis after a completed debate")
    .option("--verbose", "Show template migration notices and zero-change summaries")
    .option("-q, --quiet", "Suppress informational output")
    .option(
      "--model <model>",
      "Model to use for experts (default: from config; run 'council doctor --models' to list available models)",
      (v) => {
        if (!isSupportedModel(v)) {
          throw new Error(
            `--model received an unknown model id (got: ${v}). Valid options: ${SUPPORTED_MODELS.join(", ")}`,
          );
        }
        return v;
      },
    )
    .option("--max-experts <n>", "Maximum number of experts for auto-compose", (v) => {
      const parsed = Number(v);
      if (!Number.isInteger(parsed)) {
        throw new Error(`--max-experts must be an integer (got: ${v})`);
      }
      return parsed;
    })
    .action(async (topicArg: string | undefined, raw: ConveneOptions, command: Command) => {
      // setQuiet() mutates module-global state in writer.ts. Snapshot the prior
      // value and restore it in the finally so a second in-process invocation
      // (tests, library use, REPL/daemon) doesn't inherit quiet=true (#895).
      const priorQuiet = isQuiet();
      try {
        if (raw.quiet === true) {
          setQuiet(true);
        }
        warnOnStrayExpertArgs(command, writeError);

        // Resolve the topic from either the positional <topic> or --prompt-file.
        // --prompt-file is the bulletproof input channel: it reads the topic
        // VERBATIM (file contents or stdin), bypassing the shell entirely so
        // `$`, backticks, and values like `$180K` survive. The two sources are
        // mutually exclusive (mirrors the --experts / --template pattern).
        const promptFile = raw.promptFile;
        if (promptFile !== undefined && topicArg !== undefined) {
          const message =
            "Cannot combine a positional <topic> with --prompt-file. Pass the topic as an argument OR via --prompt-file, not both.";
          writeError(message + "\n");
          throw new CliUserError(message);
        }

        let topic: string;
        let topicSource: TopicSource;
        if (promptFile !== undefined) {
          topicSource = "file";
          try {
            topic = await readTextInput(promptFile);
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            writeError(message + "\n");
            throw new CliUserError(message);
          }
        } else if (topicArg !== undefined) {
          topicSource = "arg";
          topic = topicArg;
        } else if (!isNonInteractive() && !isQuiet()) {
          topicSource = "interactive";
          topic = await (deps.topicInputProvider ?? promptForTopic)();
        } else {
          const message =
            "No topic provided. Pass a positional <topic>, or use --prompt-file <path> (or --prompt-file - to read stdin). When running in a terminal, omit the topic argument to enter it interactively.";
          writeError(message + "\n");
          throw new CliUserError(message);
        }

        // Reject empty/whitespace-only --prompt-file (and stdin) content. The
        // source-aware heuristic intentionally suppresses the empty-after-trim
        // residue signal for non-arg sources, so without this explicit check an
        // empty file would silently launch a useless blank-topic debate. A CLI
        // positional is exempt: an empty arg is the shell-mangled-away case that
        // keeps its existing warn-and-proceed behavior.
        if (topicSource === "file" && topic.trim().length === 0) {
          const message =
            "Topic from --prompt-file is empty. Provide a non-empty topic (file contents, or piped stdin for `--prompt-file -`).";
          writeError(message + "\n");
          throw new CliUserError(message);
        }

        const admission = checkTopicAdmission(topic, topicSource);
        for (const warning of admission.warnings) {
          writeError(warning + "\n");
        }

        // Confirm-on-detect (PM-02): when the shell-expansion heuristic fires for
        // a shell-argument topic, the shell may have silently altered the text
        // before Council ever saw it. In an interactive session, echo what we
        // actually received and require explicit confirmation before launching
        // the debate. Skipped for --yes, --quiet, and non-interactive shells
        // (which keep the existing warn-and-proceed behavior). File and stdin
        // input never reach the shell, so they are never gated here.
        if (
          topicSource === "arg" &&
          raw.yes !== true &&
          !isQuiet() &&
          detectShellExpansion(topic, "arg")
        ) {
          const confirmTopic = async (provider: ConfirmProvider): Promise<void> => {
            writeError(`Received topic: ${truncatePrompt(toSingleLineDisplay(topic))}\n`);
            const proceed = await provider.confirm("Proceed with this topic? [y/N] ");
            if (!proceed) {
              const message =
                "Aborted: topic not confirmed. Re-run with the topic in SINGLE quotes, or use --prompt-file <path>.";
              writeError(message + "\n");
              throw new CliUserError(message);
            }
          };
          const confirmFactory = deps.topicConfirmProvider;
          if (confirmFactory) {
            await confirmTopic(confirmFactory());
          } else if (!isNonInteractive()) {
            await confirmTopic(createReadlineConfirmProvider());
          }
          // else: non-interactive with no injected provider -> warn-and-proceed.
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
          if (mockWarningEmitted || resolvedEngine !== "mock") {
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
          const msg =
            "Cannot use --experts together with --template/--panel. Pass one or the other.";
          writeError(`${msg}\n`);
          throw new CliUserError(msg);
        }

        // Validate --max-experts if provided
        if (raw.maxExperts !== undefined) {
          if (!Number.isFinite(raw.maxExperts) || raw.maxExperts < 1) {
            const msg = `--max-experts must be a positive integer (got: ${raw.maxExperts})`;
            writeError(`${msg}\n`);
            throw new CliUserError(msg);
          }
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
          conclude: raw.conclude !== false,
          ...(raw.strategy !== undefined ? { strategy: raw.strategy } : {}),
          ...(raw.contextScope !== undefined ? { contextScope: raw.contextScope } : {}),
          ...(raw.summarizeAfter !== undefined && Number.isFinite(raw.summarizeAfter)
            ? { summarizeAfter: raw.summarizeAfter }
            : {}),
          ...(raw.maxExperts !== undefined && Number.isFinite(raw.maxExperts)
            ? { maxExperts: raw.maxExperts }
            : {}),
        };

        // Tracks whether the panel was LLM-composed at convene time (no
        // `--template`/`--experts`). Only auto-composed panels are
        // run-scoped library orphans, so only they get the "save this panel"
        // next-step hint after the debate.
        let autoComposed = false;
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

          const panel = await loadPanelFriendly(opts.template, dataHome, writeError);
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
                  `Panel "${toSingleLineDisplay(opts.template)}" references experts not in the library: ${missing.map((s) => toSingleLineDisplay(s)).join(", ")}. ` +
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
          const expertSlugs = parseExpertSlugs(opts.experts);
          if (expertSlugs.length === 0) {
            const msg = "--experts requires at least one expert slug.";
            writeError(`${msg}\n`);
            throw new CliUserError(msg);
          }
          const libDb = await createDatabase(libDbPath);
          try {
            const library = new FileExpertLibrary(dataHome, libDb);
            const { resolved, missing } = await resolveExperts(expertSlugs, library);
            if (missing.length > 0) {
              const validSlugs = (await library.list()).map((e) => e.slug);
              const named = missing
                .map((slug) => {
                  const safe = toSingleLineDisplay(slug);
                  const suggestions = suggestMatch(slug, validSlugs);
                  return suggestions.length > 0
                    ? `'${safe}' (did you mean ${suggestions
                        .map((s) => `'${toSingleLineDisplay(s)}'`)
                        .join(", ")}?)`
                    : `'${safe}'`;
                })
                .join(", ");
              const msg =
                `--experts references experts not in the library: ${named}. ` +
                `Run 'council expert list' to see valid slugs, or omit --experts to auto-compose a panel from your topic.`;
              writeError(`${msg}\n`);
              throw new CliUserError(msg);
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
          autoComposed = true;
          emitMockWarning();
          const composeEngine = deps.engineFactory
            ? deps.engineFactory()
            : makeEngineFromKind(opts.engine);
          const composeProgress = createProgress({
            stream: { write: writeError, isTTY: process.stderr.isTTY },
            quiet: isQuiet(),
          });
          composeProgress.start("Composing panel");
          try {
            await composeEngine.start();
            try {
              const autoComposeOptions: {
                defaultModel: string;
                maxExperts?: number;
                minExperts?: number;
              } = { defaultModel };

              // Precedence: --max-experts CLI flag > config.defaults.maxExperts >
              // auto-compose hardcoded default. When either source provides a value,
              // also set minExperts to avoid impossible ranges.
              const resolvedMaxExperts = opts.maxExperts ?? config.defaults.maxExperts;
              if (resolvedMaxExperts !== undefined) {
                autoComposeOptions.maxExperts = resolvedMaxExperts;
                // Ensure min ≤ max: if maxExperts is less than default minimum (3), clamp min
                autoComposeOptions.minExperts = Math.min(3, resolvedMaxExperts);
              }

              composeProgress.update("Selecting experts");
              template = await autoComposePanel(topic, composeEngine, autoComposeOptions);
            } catch (err: unknown) {
              const cause = err instanceof Error ? err.message : String(err);
              throw new Error(
                `Could not auto-compose a panel for this topic. Use --template to specify one manually. (cause: ${cause})`,
              );
            }
          } finally {
            composeProgress.stop();
            await composeEngine.stop().catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              writeError(`!! engine.stop() failed during auto-compose cleanup: ${msg}\n`);
            });
          }
          writeInformationalNotice(
            `\n🏛️  Auto-composed panel for this run: ${toSingleLineDisplay(template.name)}\n` +
              "   (Not saved to your library — it exists only for this debate.)\n",
          );
          for (const expert of template.experts) {
            writeInformationalNotice(
              `  • ${toSingleLineDisplay(expert.displayName)} — ${toSingleLineDisplay(expert.role)}\n`,
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
              const msg =
                "Non-interactive shell detected. Auto-compose requires --yes in non-interactive mode.";
              writeError(`${msg}\n`);
              throw new CliUserError(msg);
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

          // Build human expert specs from --human flags. A human's identity
          // key is slugify(displayName); reject any name that produces an
          // empty slug (punctuation/emoji-only) or one that collides with an
          // AI expert already on the panel — or with another --human. The
          // experts table is UNIQUE(panel_id, slug), so a duplicate would
          // otherwise break turn attribution or surface as a raw DB error
          // AFTER a panel row was already persisted (#207).
          const aiSlugs = new Set(aiExperts.map((e) => e.slug));
          const seenHumanSlugs = new Set<string>();
          const humanExperts: ExpertSpec[] = humanNames.map((name) => {
            const slug = slugify(name);
            const safeName = toSingleLineDisplay(name);
            if (slug.length === 0) {
              const msg =
                `--human "${safeName}" has no letters or digits to build a slug from. ` +
                `Give the participant a name containing at least one letter or number.`;
              writeError(`${msg}\n`);
              throw new CliUserError(msg);
            }
            if (aiSlugs.has(slug)) {
              const msg =
                `--human "${safeName}" maps to the slug "${slug}", which already belongs to an ` +
                `expert on this panel. Rename the human participant so its slug is distinct.`;
              writeError(`${msg}\n`);
              throw new CliUserError(msg);
            }
            if (seenHumanSlugs.has(slug)) {
              const msg =
                `--human "${safeName}" maps to the slug "${slug}", which duplicates another ` +
                `--human participant. Give each human a name with a distinct slug.`;
              writeError(`${msg}\n`);
              throw new CliUserError(msg);
            }
            seenHumanSlugs.add(slug);
            return {
              id: ulid(),
              slug,
              displayName: name,
              model: "human",
              systemMessage: "(human participant)",
            };
          });

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

          // Captured after the session row is created so the post-debate
          // next-step hint can reference the real (timestamped) session name.
          let sessionName: string | undefined;

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
                // T9: persist the FULL resolved panel definition so a session
                // can later be promoted to a reusable library panel via
                // `council panel save`. Additive — existing readers key off
                // `template`/`mode`/`engine` and are unaffected.
                definition: buildPersistedPanelDefinition(template),
              }),
            });
            sessionName = panel.name;

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

            // T1 RAG: retrieve documents relevant to the topic and inject them
            // as a shared [REFERENCE DOCUMENTS] block into every expert turn
            // (see Debate.#runAiTurn). Known library panels (--template/--panel)
            // scope to that panel's indexed docs; ad-hoc (--experts) and
            // auto-composed panels have no stable panel slug, so they fall back
            // to searching all indexed documents. Best-effort: a retrieval
            // failure must never block the debate.
            let referenceDocuments: readonly DocumentSnippet[] = [];
            try {
              const retriever = createDocumentRetriever(db);
              const retrieveOptions =
                opts.template !== undefined
                  ? { panelName: template.name, maxResults: 5 }
                  : { sources: "all" as const, maxResults: 5 };
              const snippets = await retriever.retrieve(topic, retrieveOptions);
              referenceDocuments = capSnippetsByChars(snippets, REFERENCE_DOCS_CHAR_CAP);
            } catch (err) {
              writeError(formatRetrievalFailureWarning(err));
            }

            await runWithEngine({
              engineKind: opts.engine,
              engineFactory: deps.engineFactory,
              experts: allExperts,
              debateConfig: {
                maxRounds: opts.maxRounds,
                maxWordsPerResponse: opts.maxWords,
                mode: opts.mode,
                qualityGate: config.qualityGate,
                ...(strategy !== undefined ? { strategy } : {}),
                ...(contextConfig !== undefined ? { contextConfig } : {}),
                ...(referenceDocuments.length > 0 ? { referenceDocuments } : {}),
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
              quiet: isQuiet(),
              db,
              signal: debateController.signal,
              humanSlugs: humanSlugs.size > 0 ? humanSlugs : undefined,
              humanInput: humanSlugs.size > 0 ? deps.humanInputFactory?.() : undefined,
              beforeRender: emitMockWarning,
              preamble: () => {
                write(`\n# ${toSingleLineDisplay(template.name)}\n`);
                write(`Topic: ${truncatePrompt(toSingleLineDisplay(topic))}\n`);
                write(
                  `Mode: ${opts.mode} | Max rounds: ${opts.maxRounds} | Engine: ${opts.engine}\n`,
                );
                if (humanNames.length > 0) {
                  write(`Human participants: ${humanNames.join(", ")}\n`);
                }
                write("\n");
              },
              onDebateComplete: async (ctx) => {
                if (opts.conclude !== false) {
                  try {
                    const doc = await loadTranscript(ctx.db, panel.name);
                    if (
                      doc.latestDebate.id === ctx.debateId &&
                      doc.latestDebate.status === "completed"
                    ) {
                      writeError(
                        "Generating conclusion (1 more premium request; may retry once if JSON is unparseable; use --no-conclude to skip)\n",
                      );
                      // TTY-gated live status during the conclusion-synthesis
                      // wait. Suppressed for non-TTY (CI/pipes), --quiet, and
                      // JSON output so machine consumers and CI logs stay clean.
                      const concludeProgress = createProgress({
                        stream: { write: writeError, isTTY: process.stderr.isTTY },
                        quiet: isQuiet(),
                      });
                      const showConcludeProgress =
                        process.stderr.isTTY === true && opts.format !== "json" && !isQuiet();
                      if (showConcludeProgress) {
                        concludeProgress.start("Generating conclusion");
                      }
                      try {
                        const conclusion = await synthesizeConclusion({
                          doc,
                          panelName: panel.name,
                          engine: ctx.engine,
                          model: defaultModel,
                          maxTranscriptChars: config.conclude.maxTranscriptChars,
                        });
                        if (opts.format === "json") {
                          write(JSON.stringify({ kind: "conclusion", conclusion }) + "\n");
                        } else {
                          write(renderConclusionPlain(conclusion));
                        }
                      } finally {
                        if (showConcludeProgress) {
                          concludeProgress.stop();
                        }
                      }
                    }
                  } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    writeError(
                      `!! conclusion generation failed (continuing): ${toSingleLineDisplay(msg)}\n`,
                    );
                  }
                }
                if (opts.heuristicMemory !== true) {
                  await runExtractMemoryHook({
                    engine: ctx.engine,
                    db: ctx.db,
                    panelId: ctx.panelId,
                    debateId: ctx.debateId,
                    expertSlugToId: ctx.expertSlugToId,
                    humanSlugs,
                    model: defaultModel,
                    writeError,
                  });
                }
              },
            });
          } finally {
            unsubscribeInterrupt();
          }
          if (debateInterrupted) {
            writeError("\nDebate interrupted. Partial results saved.\n");
          }
          if (opts.format !== "json" && !isQuiet()) {
            if (autoComposed && sessionName !== undefined) {
              write(formatPanelSaveHint(sessionName));
            }
            write(
              'Tip: Try `council ask <panel> "<question>"` for follow-ups, or `council sessions` to review past debates.\n',
            );
          }
        } finally {
          await db.destroy().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            writeError(`!! db.destroy() failed during cleanup: ${msg}\n`);
          });
        }
      } finally {
        setQuiet(priorQuiet);
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
Bulletproof option — read the topic VERBATIM from a file or stdin (no shell):
  $ council convene --prompt-file topic.txt --engine copilot
  $ echo 'We have $180K in runway' | council convene --prompt-file - --engine copilot

Premium Requests:
  The "[Premium requests: N (est. ~T)]" counter shown during a debate is an
  ESTIMATE — T ≈ experts × rounds (freeform) or experts × phases (structured).
  The debate does NOT stop when the count reaches T; the display is informational only.
  Reduce usage:
    --max-rounds <n>   Fewer rounds → fewer total turns
    --max-experts <n>  Smaller panel → fewer concurrent turns per round
    --panel <name>     Pick a purpose-built panel with fewer experts
`,
  );

  // CLI-05: Help tiering — separate common vs advanced flags
  const COMMON_FLAGS = new Set([
    "--template",
    "--prompt-file",
    "--engine",
    "--format",
    "--max-rounds",
    "--yes",
  ]);

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

/**
 * Matches the validation failure raised when a panel's `experts` array is
 * empty (Zod `.min(1)` on the experts list). Used to translate the raw Zod
 * message into friendly, jargon-free guidance at the command boundary.
 */
const ZERO_EXPERT_VALIDATION_PATTERN = /experts:.*(too small|expected array|at least 1|>=\s*1)/is;

/**
 * Load a panel by name, translating the zero-expert schema-validation error
 * into a friendly message (F11). Other load errors propagate unchanged so the
 * user still sees actionable detail (bad YAML, traversal rejection, etc.).
 */
async function loadPanelFriendly(
  name: string,
  dataHome: string,
  writeError: Writer,
): Promise<Awaited<ReturnType<typeof loadPanel>>> {
  try {
    return await loadPanel(name, dataHome);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (ZERO_EXPERT_VALIDATION_PATTERN.test(message)) {
      const friendly =
        `Panel "${toSingleLineDisplay(name)}" has no experts. ` +
        `A panel needs at least one expert — add experts to the panel definition or re-create the panel.`;
      writeError(`${friendly}\n`);
      throw new CliUserError(friendly);
    }
    throw err;
  }
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
