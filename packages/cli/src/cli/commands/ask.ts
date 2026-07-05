/**
 * `council ask <panel> "<question>" [--expert <slug>] [--engine <kind>]`
 *
 * One-shot single-expert chat. Picks one expert from an existing panel,
 * runs a 1-round 1-expert debate through the full pipeline via the
 * shared `runWithEngine()` helper.
 */
import * as path from "node:path";

import { Command, Option } from "commander";

import { CliUserError } from "../cli-user-error.js";
import {
  getCouncilDataHome,
  getCouncilHome,
  loadConfig,
  resolveEngine,
  DEFAULT_MODEL,
  type CouncilConfig,
} from "../../config/index.js";
import { PanelNotFoundError } from "../../core/template-loader.js";
import { buildSystemPrompt } from "../../core/prompt-builder.js";
import { createDocumentRetriever, type DocumentSnippet } from "../../core/documents/retriever.js";
import {
  capSnippetsByChars,
  REFERENCE_DOCS_CHAR_CAP,
} from "../../core/documents/reference-block.js";
import {
  checkTopicAdmission,
  detectShellExpansion,
  type TopicSource,
} from "../../core/topic-admission.js";
import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import { createDatabase, type CouncilDatabase } from "../../memory/db.js";
import { ExpertRepository } from "../../memory/repositories/experts.js";
import { PanelRepository } from "../../memory/repositories/panels.js";
import { TurnRepository } from "../../memory/repositories/turns.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";
import { ENGINE_KINDS, type EngineKind, runWithEngine } from "../run-with-engine.js";
import { RENDERER_FORMATS, type RendererFormat } from "../renderers/select.js";
import { createReadlineConfirmProvider, type ConfirmProvider } from "./confirm.js";
import { isNonInteractive } from "../non-interactive.js";
import { readTextInput } from "../read-text-input.js";
import { toSingleLineDisplay } from "../strip-control-chars.js";
import { truncatePrompt } from "../renderers/truncate-prompt.js";
import { createProgress } from "../progress.js";

const DEFAULT_MAX_WORDS = 250;

export type { ConfirmProvider } from "./confirm.js";

export interface AskCommandDeps {
  readonly engineFactory?: () => CouncilEngine;
  readonly write?: Writer;
  readonly writeError?: Writer;
  /**
   * Factory to create a ConfirmProvider for the shell-expansion
   * confirm-on-detect prompt (PM-02). When omitted, a readline-backed
   * default is used (gated by {@link isNonInteractive}).
   */
  readonly topicConfirmProvider?: () => ConfirmProvider;
}

export function buildAskCommand(deps: AskCommandDeps = {}): Command {
  const write: Writer = deps.write ?? defaultWriter;
  const writeError: Writer = deps.writeError ?? defaultErrorWriter;

  const cmd = new Command("ask");
  cmd
    .description(
      "Ask one expert from an existing panel a single question. " +
        "For multi-expert debates use `council convene`. For conversation use `council chat`.",
    )
    .argument(
      "<panel>",
      "Panel name from a previous debate (as shown by `council sessions`). " +
        "For library experts, use `council chat`.",
    )
    .argument("[question]", "The question to ask (optional when --prompt-file is used)")
    .option(
      "--prompt-file <path>",
      "Read the question VERBATIM from a file (or `-` for stdin) instead of the positional argument. " +
        "Bypasses the shell so `$`, backticks, and values like `$180K` survive intact. " +
        "Mutually exclusive with the positional <question>.",
    )
    .addOption(
      new Option("--engine <kind>", "Engine to use (default: from config)").choices([
        ...ENGINE_KINDS,
      ]),
    )
    .option("--expert <slug>", "Expert slug to ask (default: first expert in the panel)")
    .addOption(
      new Option("--format <kind>", "Output format").choices([...RENDERER_FORMATS]).default("auto"),
    )
    .option(
      "--max-words <n>",
      "Soft per-response word budget (opening-phase anchor; structured mode scales the other phases)",
      (v) => Number.parseInt(v, 10),
      DEFAULT_MAX_WORDS,
    )
    .action(
      async (
        panelName: string,
        questionArg: string | undefined,
        raw: {
          engine?: EngineKind;
          expert?: string;
          format?: string;
          maxWords?: number;
          promptFile?: string;
        },
        command: Command,
      ) => {
        // Resolve quiet from this invocation's PARSED options (its own --quiet
        // merged with the global) instead of the writer module-global, so
        // back-to-back commands in one process can't leak quiet state into one
        // another (#849).
        const quiet = (command.optsWithGlobals() as { quiet?: boolean }).quiet === true;

        // Resolve the question from either the positional <question> or
        // --prompt-file. --prompt-file reads the question VERBATIM (file
        // contents or stdin), bypassing the shell entirely so `$`, backticks,
        // and values like `$180K` survive. The two sources are mutually
        // exclusive.
        const promptFile = raw.promptFile;
        if (promptFile !== undefined && questionArg !== undefined) {
          const message =
            "Cannot combine a positional <question> with --prompt-file. Pass the question as an argument OR via --prompt-file, not both.";
          writeError(message + "\n");
          throw new CliUserError(message);
        }

        let question: string;
        let questionSource: TopicSource;
        if (promptFile !== undefined) {
          questionSource = "file";
          try {
            question = await readTextInput(promptFile);
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            writeError(message + "\n");
            throw new CliUserError(message);
          }
        } else if (questionArg !== undefined) {
          questionSource = "arg";
          question = questionArg;
        } else {
          const message =
            "No question provided. Pass a positional <question>, or use --prompt-file <path> (or --prompt-file - to read stdin).";
          writeError(message + "\n");
          throw new CliUserError(message);
        }

        // Reject empty/whitespace-only --prompt-file (and stdin) content. The
        // source-aware heuristic intentionally suppresses the empty-after-trim
        // residue signal for non-arg sources, so without this explicit check an
        // empty file would silently launch a useless blank-question call. A CLI
        // positional is exempt: an empty arg is the shell-mangled-away case that
        // keeps its existing warn-and-proceed behavior.
        if (questionSource === "file" && question.trim().length === 0) {
          const message =
            "Question from --prompt-file is empty. Provide a non-empty question (file contents, or piped stdin for `--prompt-file -`).";
          writeError(message + "\n");
          throw new CliUserError(message);
        }

        const admission = checkTopicAdmission(question, questionSource);
        for (const warning of admission.warnings) {
          writeError(warning + "\n");
        }

        // Confirm-on-detect (PM-02): when the shell-expansion heuristic fires
        // for a shell-argument question, the shell may have silently altered
        // the text before Council saw it. In an interactive session, echo what
        // we received and require confirmation before running the (expensive)
        // single-expert call. Skipped for --quiet and non-interactive shells
        // (warn-and-proceed). File and stdin input never reach the shell, so
        // they are never gated here.
        if (questionSource === "arg" && !quiet && detectShellExpansion(question, "arg")) {
          const confirmQuestion = async (provider: ConfirmProvider): Promise<void> => {
            writeError(`Received question: ${truncatePrompt(toSingleLineDisplay(question))}\n`);
            const proceed = await provider.confirm("Proceed with this question? [y/N] ");
            if (!proceed) {
              const message =
                "Aborted: question not confirmed. Re-run with the question in SINGLE quotes, or use --prompt-file <path>.";
              writeError(message + "\n");
              throw new CliUserError(message);
            }
          };
          const confirmFactory = deps.topicConfirmProvider;
          if (confirmFactory) {
            await confirmQuestion(confirmFactory());
          } else if (!isNonInteractive()) {
            await confirmQuestion(createReadlineConfirmProvider());
          }
          // else: non-interactive with no injected provider -> warn-and-proceed.
        }

        let loadedConfig: CouncilConfig | undefined;
        const getConfig = async (): Promise<CouncilConfig> => {
          loadedConfig ??= await loadConfig();
          return loadedConfig;
        };
        const resolvedEngine = raw.engine ?? resolveEngine(undefined, await getConfig());
        const format: RendererFormat = parseFormat(raw.format);
        const maxWords = Number.isFinite(raw.maxWords)
          ? (raw.maxWords ?? DEFAULT_MAX_WORDS)
          : DEFAULT_MAX_WORDS;

        if (resolvedEngine === "mock") {
          writeError(
            "\n!! [MOCK ENGINE] Running with deterministic offline mock — response is NOT real.\n\n",
          );
        }

        const dbPath = path.join(getCouncilHome(), "council.db");
        const db = await createDatabase(dbPath);
        try {
          // Active debate session by that name takes precedence — this path is
          // unchanged (existing `council ask <session-handle>` behavior).
          const activePanel = await new PanelRepository(db).findByName(panelName);
          if (activePanel) {
            const allExperts = await new ExpertRepository(db).findByPanelId(activePanel.id);
            if (allExperts.length === 0) {
              throw new Error(
                `Panel '${panelName}' has no experts. Run \`council convene\` to populate one.`,
              );
            }

            const selectedExpert = raw.expert
              ? allExperts.find((e) => e.slug === raw.expert)
              : allExperts[0];

            if (!selectedExpert) {
              throw new Error(
                `No expert found with slug '${raw.expert}' in panel '${panelName}'. Available: ${allExperts.map((e) => e.slug).join(", ")}`,
              );
            }

            const expertSpec: ExpertSpec = {
              id: selectedExpert.id,
              slug: selectedExpert.slug,
              displayName: selectedExpert.displayName,
              model: selectedExpert.model,
              systemMessage: selectedExpert.systemMessage,
            };

            await runOneExpertAsk({
              db,
              engineKind: resolvedEngine,
              engineFactory: deps.engineFactory,
              expertSpec,
              panelId: activePanel.id,
              panelDisplayName: activePanel.name,
              question,
              maxWords,
              format,
              write,
              writeError,
              quiet,
            });
            return;
          }

          // No active session by that name — fall back to the saved/library
          // panel path so a saved kebab-case panel (or a built-in template such
          // as `code-review`) can be asked headlessly (F-11). A saved panel's
          // managed documents are engaged via RAG so a PM can Q&A them without
          // the interactive (TTY-only) `council chat`.
          const config = await getConfig();
          const dataHome = process.env["COUNCIL_DATA_HOME"]?.length
            ? getCouncilDataHome()
            : getCouncilDataHome(config);
          await runSavedPanelAsk({
            db,
            panelName,
            expertSlug: raw.expert,
            question,
            maxWords,
            format,
            engineKind: resolvedEngine,
            engineFactory: deps.engineFactory,
            config,
            dataHome,
            write,
            writeError,
            quiet,
          });
        } finally {
          await db.destroy().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            writeError(`!! db.destroy() failed during cleanup: ${msg}\n`);
          });
        }
      },
    );

  cmd.addHelpText(
    "after",
    `
Examples:
  $ council ask my-panel "What about the migration risk?" --engine copilot
  $ council ask my-panel "Quick follow-up" --expert cto --engine copilot

Shell quoting: bash and PowerShell both expand $variables inside double quotes.
Wrap questions containing $, !, or backticks in SINGLE quotes to keep them literal:
  bash       $ council ask my-panel 'Is the $450 cost justified?' --engine copilot
  PowerShell > council ask my-panel 'Is the $450 cost justified?' --engine copilot
Bulletproof option — read the question VERBATIM from a file or stdin (no shell):
  $ council ask my-panel --prompt-file question.txt --engine copilot
  $ echo 'Is the $450 cost justified?' | council ask my-panel --prompt-file - --engine copilot
`,
  );

  return cmd;
}

interface RunOneExpertAskParams {
  readonly db: CouncilDatabase;
  readonly engineKind: EngineKind;
  readonly engineFactory?: (() => CouncilEngine) | undefined;
  readonly expertSpec: ExpertSpec;
  readonly panelId: string;
  /** Human-facing panel label written in the plain-text preamble. */
  readonly panelDisplayName: string;
  readonly question: string;
  readonly maxWords: number;
  readonly format: RendererFormat;
  /** Retrieved RAG snippets (F-11). When non-empty, Debate appends the
   * shared `[REFERENCE DOCUMENTS]` block to every expert turn. */
  readonly referenceDocuments?: readonly DocumentSnippet[] | undefined;
  readonly write: Writer;
  readonly writeError: Writer;
  readonly quiet: boolean;
}

/**
 * Run a single expert through the 1-round debate pipeline and enforce the
 * #194 "no answer produced" guard. Shared by both the active-session path
 * and the saved-panel headless fallback so their engine wiring and
 * failure handling stay identical.
 */
async function runOneExpertAsk(params: RunOneExpertAskParams): Promise<void> {
  const {
    db,
    engineKind,
    engineFactory,
    expertSpec,
    panelId,
    panelDisplayName,
    question,
    maxWords,
    format,
    referenceDocuments,
    write,
    writeError,
    quiet,
  } = params;

  // expertSpec.displayName/.slug can be LLM-sourced (auto-composed panels),
  // so sanitize them before every DIRECT terminal sink to stop ANSI/CR/LF
  // injection from forging or overwriting output. The engine and persistence
  // layers keep the original values (expertSpec).
  const expertDisplayName = toSingleLineDisplay(expertSpec.displayName);
  const expertSlugDisplay = toSingleLineDisplay(expertSpec.slug);

  const setupProgress = createProgress({
    stream: { write: writeError, isTTY: process.stderr.isTTY },
    quiet,
  });
  setupProgress.start("Preparing answer");
  let answeredDebateId: string | undefined;
  try {
    await runWithEngine({
      engineKind,
      engineFactory,
      experts: [expertSpec],
      debateConfig: {
        maxRounds: 1,
        maxWordsPerResponse: maxWords,
        mode: "freeform",
        ...(referenceDocuments !== undefined && referenceDocuments.length > 0
          ? { referenceDocuments }
          : {}),
      },
      prompt: question,
      panelId,
      expertSlugToId: { [expertSpec.slug]: expertSpec.id },
      moderator: "ask-single-expert",
      format,
      write,
      writeError,
      quiet,
      db,
      beforeRender: () => {
        setupProgress.stop();
      },
      onDebateComplete: ({ debateId }) => {
        answeredDebateId = debateId;
        return Promise.resolve();
      },
      preamble: () => {
        write(`\n# Asking ${expertDisplayName} (${expertSlugDisplay})\n`);
        write(`Panel: ${panelDisplayName}\n`);
        write(`Question: ${question}\n\n`);
      },
    });
  } finally {
    setupProgress.stop();
  }

  // #194: a single-expert debate reports debate.end reason="completed"
  // even when the lone expert errored out after retries — so a clean
  // exit 0 would hide that the user got no answer. The expert produced
  // an answer iff a turn row was persisted; zero turns means failure.
  const persistedTurns = answeredDebateId
    ? await new TurnRepository(db).findByDebateId(answeredDebateId)
    : [];
  if (persistedTurns.length === 0) {
    const message = `${expertDisplayName} (${expertSlugDisplay}) did not respond — no answer was produced. The expert failed; see the error above. Retry, or pick another expert with --expert.`;
    writeError(message + "\n");
    throw new CliUserError(message);
  }

  if (format !== "json" && !quiet) {
    write(
      "Tip: Use `council convene --template <panel>` for a full debate, or `council chat <panel>` for conversation.\n",
    );
  }
}

interface RunSavedPanelAskParams {
  readonly db: CouncilDatabase;
  readonly panelName: string;
  readonly expertSlug: string | undefined;
  readonly question: string;
  readonly maxWords: number;
  readonly format: RendererFormat;
  readonly engineKind: EngineKind;
  readonly engineFactory?: (() => CouncilEngine) | undefined;
  readonly config: CouncilConfig;
  readonly dataHome: string;
  readonly write: Writer;
  readonly writeError: Writer;
  readonly quiet: boolean;
}

/**
 * Headless fallback for `council ask <saved-panel>` (F-11): when no active
 * debate session matches the name, load the saved/library panel, resolve its
 * experts, spin up a one-shot runtime panel + expert row (mirroring
 * `convene`), engage the panel's managed documents via RAG, and answer with a
 * single expert. Both a saved kebab-case panel and a built-in template resolve
 * through {@link loadSavedPanelExperts}.
 */
async function runSavedPanelAsk(params: RunSavedPanelAskParams): Promise<void> {
  const {
    db,
    panelName,
    expertSlug,
    question,
    maxWords,
    format,
    engineKind,
    engineFactory,
    config,
    dataHome,
    write,
    writeError,
    quiet,
  } = params;

  // The scanner + its extractors are only needed on this less-common path, so
  // load them lazily — keeping the active-session ask startup lean.
  const { loadSavedPanelExperts, scanPanelDocuments } = await import("./saved-panel-runtime.js");

  let panel;
  let resolved;
  let missing;
  try {
    ({ panel, resolved, missing } = await loadSavedPanelExperts(panelName, dataHome, db));
  } catch (err: unknown) {
    if (err instanceof PanelNotFoundError) {
      const message =
        `No panel found with name '${panelName}'. Run \`council sessions\` to list active ` +
        `sessions, or \`council panel list\` to see saved panels.`;
      writeError(message + "\n");
      throw new CliUserError(message);
    }
    throw err;
  }

  for (const slug of missing) {
    writeError(`⚠ Expert "${toSingleLineDisplay(slug)}" not found in library.\n`);
  }
  if (resolved.length === 0) {
    const message = `Panel '${panelName}' has no available experts. Restore the panel's expert files, or recreate it with \`council panel\`.`;
    writeError(message + "\n");
    throw new CliUserError(message);
  }

  const selectedDef = expertSlug ? resolved.find((e) => e.slug === expertSlug) : resolved[0];
  if (!selectedDef) {
    const message = `No expert found with slug '${expertSlug}' in panel '${panelName}'. Available: ${resolved
      .map((e) => toSingleLineDisplay(e.slug))
      .join(", ")}`;
    writeError(message + "\n");
    throw new CliUserError(message);
  }

  // One-shot runtime panel + expert row (mirrors convene's persistence) so the
  // debate has a panel_id and expert_id to attribute turns to.
  const panelRow = await new PanelRepository(db).create({
    name: `${panel.name}-${new Date().toISOString().slice(0, 19)}`,
    topic: question,
    copilotHome: path.join(getCouncilHome(), "copilot"),
    configJson: JSON.stringify({ template: panel.name, mode: "freeform", engine: engineKind }),
  });
  const systemMessage = buildSystemPrompt(selectedDef, undefined, question);
  const model = selectedDef.model ?? config.defaults.model ?? DEFAULT_MODEL;
  const expertRow = await new ExpertRepository(db).create({
    panelId: panelRow.id,
    slug: selectedDef.slug,
    displayName: selectedDef.displayName,
    model,
    systemMessage,
  });
  const expertSpec: ExpertSpec = {
    id: expertRow.id,
    slug: selectedDef.slug,
    displayName: selectedDef.displayName,
    model,
    systemMessage,
  };

  // Engage docs RAG (F-11): refresh the panel's managed-docs index and retrieve
  // snippets scoped to this saved panel. Best-effort — a scan/retrieval failure
  // (or a panel with no docs) must never block the answer.
  let referenceDocuments: readonly DocumentSnippet[] = [];
  try {
    await scanPanelDocuments({ panelName, dataHome, db, config });
    const snippets = await createDocumentRetriever(db).retrieve(question, {
      panelName,
      maxResults: 5,
    });
    referenceDocuments = capSnippetsByChars(snippets, REFERENCE_DOCS_CHAR_CAP);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    writeError(
      `!! Reference-document scan/retrieval failed (continuing without documents): ${msg}\n`,
    );
  }

  await runOneExpertAsk({
    db,
    engineKind,
    engineFactory,
    expertSpec,
    panelId: panelRow.id,
    panelDisplayName: panel.name,
    question,
    maxWords,
    format,
    referenceDocuments,
    write,
    writeError,
    quiet,
  });

  // Clean up the ephemeral one-shot panel row (T-PR16 .3 from #2430): the row
  // was created for debate attribution but should not persist in the roster.
  // Cascade delete removes the expert row and any turns/debates.
  await new PanelRepository(db).delete(panelRow.id);
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
