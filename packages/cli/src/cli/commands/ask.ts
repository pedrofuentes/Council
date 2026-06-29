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
  type CouncilConfig,
} from "../../config/index.js";
import {
  PanelNotFoundError,
  TEMPLATE_NAME_PATTERN,
  loadPanel,
} from "../../core/template-loader.js";
import {
  checkTopicAdmission,
  detectShellExpansion,
  type TopicSource,
} from "../../core/topic-admission.js";
import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import { createDatabase } from "../../memory/db.js";
import { ExpertRepository } from "../../memory/repositories/experts.js";
import { PanelRepository } from "../../memory/repositories/panels.js";
import { TurnRepository } from "../../memory/repositories/turns.js";

import { defaultErrorWriter, defaultWriter, isQuiet, type Writer } from "./writer.js";
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
      ) => {
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
        if (questionSource === "arg" && !isQuiet() && detectShellExpansion(question, "arg")) {
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
          const panel = await new PanelRepository(db).findByName(panelName);
          if (!panel) {
            const dataHome = process.env["COUNCIL_DATA_HOME"]?.length
              ? getCouncilDataHome()
              : getCouncilDataHome(loadedConfig ?? (await getConfig()));
            const templateOnlyMessage = await buildTemplateOnlyMessage(panelName, dataHome);
            throw new Error(
              templateOnlyMessage ??
                `No panel found with name '${panelName}'. Run \`council sessions\` to list available panels.`,
            );
          }
          const allExperts = await new ExpertRepository(db).findByPanelId(panel.id);
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

          const setupProgress = createProgress({
            stream: { write: writeError, isTTY: process.stderr.isTTY },
            quiet: isQuiet(),
          });
          setupProgress.start("Preparing answer");
          let answeredDebateId: string | undefined;
          try {
            await runWithEngine({
              engineKind: resolvedEngine,
              engineFactory: deps.engineFactory,
              experts: [expertSpec],
              debateConfig: {
                maxRounds: 1,
                maxWordsPerResponse: maxWords,
                mode: "freeform",
              },
              prompt: question,
              panelId: panel.id,
              expertSlugToId: { [expertSpec.slug]: expertSpec.id },
              moderator: "ask-single-expert",
              format,
              write,
              writeError,
              quiet: isQuiet(),
              db,
              beforeRender: () => {
                setupProgress.stop();
              },
              onDebateComplete: ({ debateId }) => {
                answeredDebateId = debateId;
                return Promise.resolve();
              },
              preamble: () => {
                write(`\n# Asking ${selectedExpert.displayName} (${selectedExpert.slug})\n`);
                write(`Panel: ${panel.name}\n`);
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
            const message = `${selectedExpert.displayName} (${selectedExpert.slug}) did not respond — no answer was produced. The expert failed; see the error above. Retry, or pick another expert with --expert.`;
            writeError(message + "\n");
            throw new CliUserError(message);
          }

          if (format !== "json" && !isQuiet()) {
            write(
              "Tip: Use `council convene --template <panel>` for a full debate, or `council chat <panel>` for conversation.\n",
            );
          }
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

async function buildTemplateOnlyMessage(
  panelName: string,
  dataHome: string,
): Promise<string | undefined> {
  if (!TEMPLATE_NAME_PATTERN.test(panelName)) return undefined;

  try {
    await loadPanel(panelName, dataHome);
    return (
      `Panel '${panelName}' matches a library template, not an active session. ` +
      `Use \`council chat ${panelName}\` to talk with it directly, or ` +
      `\`council convene --template ${panelName}\` to start a new panel.`
    );
  } catch (err: unknown) {
    if (err instanceof PanelNotFoundError) return undefined;
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
