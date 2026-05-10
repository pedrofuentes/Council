/**
 * `council ask <panel> "<question>" [--expert <slug>] [--engine <kind>]`
 *
 * One-shot single-expert chat. Picks one expert from an existing panel,
 * runs a 1-round 1-expert debate through the full pipeline via the
 * shared `runWithEngine()` helper.
 */
import * as path from "node:path";

import { Command } from "commander";

import { getCouncilHome } from "../../config/index.js";
import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import { createDatabase } from "../../memory/db.js";
import { ExpertRepository } from "../../memory/repositories/experts.js";
import { PanelRepository } from "../../memory/repositories/panels.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";
import { ENGINE_KINDS, type EngineKind, runWithEngine } from "../run-with-engine.js";

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
    .description("Ask one expert from an existing panel a single question")
    .argument("<panel>", "Panel name (as shown by `council panels`)")
    .argument("<question>", "The question to ask")
    .requiredOption(
      "--engine <kind>",
      "Engine: 'mock' (offline, deterministic) or 'copilot' (real Copilot SDK)",
    )
    .option("--expert <slug>", "Expert slug to ask (default: first expert in the panel)")
    .option("--format <kind>", "Output format: json (NDJSON) or plain (human)", "plain")
    .option(
      "--max-words <n>",
      "Soft per-response word cap",
      (v) => Number.parseInt(v, 10),
      DEFAULT_MAX_WORDS,
    )
    .action(async (panelName: string, question: string, raw: {
      engine: EngineKind;
      expert?: string;
      format?: string;
      maxWords?: number;
    }) => {
      if (!ENGINE_KINDS.includes(raw.engine)) {
        throw new Error(
          `Unknown --engine value: ${raw.engine}. Expected one of: ${ENGINE_KINDS.join(", ")}`,
        );
      }

      const format: "json" | "plain" = raw.format === "json" ? "json" : "plain";
      const maxWords = Number.isFinite(raw.maxWords) ? (raw.maxWords ?? DEFAULT_MAX_WORDS) : DEFAULT_MAX_WORDS;

      if (raw.engine === "mock") {
        writeError(
          "\n!! [MOCK ENGINE] Running with deterministic offline mock — response is NOT real.\n\n",
        );
      }

      const dbPath = path.join(getCouncilHome(), "council.db");
      const db = await createDatabase(dbPath);
      try {
        const panel = await new PanelRepository(db).findByName(panelName);
        if (!panel) {
          throw new Error(
            `No panel found with name '${panelName}'. Run \`council panels\` to list available panels.`,
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
          engineKind: raw.engine,
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
          db,
          preamble:
            format === "plain"
              ? () => {
                  write(`\n# Asking ${selectedExpert.displayName} (${selectedExpert.slug})\n`);
                  write(`Panel: ${panel.name}\n`);
                  write(`Question: ${question}\n\n`);
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
