/**
 * `council ask <panel> "<question>" [--expert <slug>] [--engine <kind>]`
 *
 * One-shot single-expert chat. Picks one expert from an existing panel,
 * runs a 1-round 1-expert debate through the full pipeline via the
 * shared `runWithEngine()` helper.
 */
import * as path from "node:path";

import { Command, Option } from "commander";

import {
  getCouncilDataHome,
  getCouncilHome,
  loadConfig,
  resolveEngine,
  type CouncilConfig,
} from "../../config/index.js";
import { PanelNotFoundError, TEMPLATE_NAME_PATTERN, loadPanel } from "../../core/template-loader.js";
import { checkTopicAdmission } from "../../core/topic-admission.js";
import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import { createDatabase } from "../../memory/db.js";
import { ExpertRepository } from "../../memory/repositories/experts.js";
import { PanelRepository } from "../../memory/repositories/panels.js";

import { defaultErrorWriter, defaultWriter, isQuiet, type Writer } from "./writer.js";
import { ENGINE_KINDS, type EngineKind, runWithEngine } from "../run-with-engine.js";
import { RENDERER_FORMATS, type RendererFormat } from "../renderers/select.js";

const DEFAULT_MAX_WORDS = 250;

export interface AskCommandDeps {
  readonly engineFactory?: () => CouncilEngine;
  readonly write?: Writer;
  readonly writeError?: Writer;
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
    .argument("<question>", "The question to ask")
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
      "Soft per-response word cap",
      (v) => Number.parseInt(v, 10),
      DEFAULT_MAX_WORDS,
    )
    .action(
      async (
        panelName: string,
        question: string,
        raw: {
          engine?: EngineKind;
          expert?: string;
          format?: string;
          maxWords?: number;
        },
      ) => {
        const admission = checkTopicAdmission(question);
        for (const warning of admission.warnings) {
          writeError(warning + "\n");
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
              : getCouncilDataHome(loadedConfig ?? await getConfig());
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
            preamble: () => {
              write(`\n# Asking ${selectedExpert.displayName} (${selectedExpert.slug})\n`);
              write(`Panel: ${panel.name}\n`);
              write(`Question: ${question}\n\n`);
            },
          });
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
