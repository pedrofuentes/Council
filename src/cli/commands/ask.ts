/**
 * `council ask <panel> "<question>" [--expert <slug>] [--engine <kind>]`
 *
 * One-shot single-expert chat — the simplest way to consult a panel.
 * Picks one expert from an existing panel, runs a 1-round, 1-expert
 * debate through the full pipeline (engine → Debate → DebatePersister
 * → Renderer), and returns.
 *
 * Creates a NEW debate row per ask (visible in `resume`, `export`,
 * `memory`), so conversation history is fully persisted.
 *
 * `--engine` is required (no silent default). `--expert` defaults to
 * the first expert in the panel if omitted.
 *
 * Out of scope (deferred):
 *   - Memory recall into the ask prompt (§3.1)
 *   - Multi-turn interactive ask (REPL-style)
 *   - Ad-hoc panel creation (`council ask --model gpt-5.4 "question"`)
 *   - `--model` override per ask (expert's model from the panel is used)
 */
import * as path from "node:path";

import { Command } from "commander";

import { getCouncilHome } from "../../config/index.js";
import { Debate, type DebateConfig } from "../../core/debate.js";
import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import { MockEngine } from "../../engine/mock/mock-engine.js";
import { CopilotEngine } from "../../engine/copilot/adapter.js";
import { createDatabase } from "../../memory/db.js";
import { DebateRepository } from "../../memory/repositories/debates.js";
import { ExpertRepository } from "../../memory/repositories/experts.js";
import { PanelRepository } from "../../memory/repositories/panels.js";
import { TurnRepository } from "../../memory/repositories/turns.js";
import { DebatePersister } from "../../memory/persister.js";

import { JsonRenderer } from "../renderers/json.js";
import { PlainRenderer } from "../renderers/plain.js";
import type { Sink } from "../renderers/types.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";
import { formatEngineError } from "../error-mapper.js";

const DEFAULT_MAX_WORDS = 250;
const ASK_ENGINE_KINDS = ["mock", "copilot"] as const;
type AskEngineKind = (typeof ASK_ENGINE_KINDS)[number];

export interface AskCommandDeps {
  readonly engineFactory?: () => CouncilEngine;
  readonly write?: Writer;
  readonly writeError?: Writer;
}

function makeEngineFromKind(kind: AskEngineKind): CouncilEngine {
  switch (kind) {
    case "mock":
      return new MockEngine();
    case "copilot":
      return new CopilotEngine();
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown engine kind: ${String(_exhaustive)}`);
    }
  }
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
      engine: AskEngineKind;
      expert?: string;
      format?: string;
      maxWords?: number;
    }) => {
      if (!ASK_ENGINE_KINDS.includes(raw.engine)) {
        throw new Error(
          `Unknown --engine value: ${raw.engine}. Expected one of: ${ASK_ENGINE_KINDS.join(", ")}`,
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
      let engine: CouncilEngine | undefined;
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

        engine = deps.engineFactory ? deps.engineFactory() : makeEngineFromKind(raw.engine);
        try {
          await engine.start();
          await engine.addExpert(expertSpec);

          const config: DebateConfig = {
            maxRounds: 1,
            maxWordsPerResponse: maxWords,
            mode: "freeform",
          };

          const debateRepo = new DebateRepository(db);
          const turnRepo = new TurnRepository(db);
          const persister = new DebatePersister({
            debates: debateRepo,
            turns: turnRepo,
            panelId: panel.id,
            expertSlugToId: { [expertSpec.slug]: expertSpec.id },
            moderator: "ask-single-expert",
          });

          const sink: Sink = { write, writeError };
          const renderer = format === "json" ? new JsonRenderer(sink) : new PlainRenderer(sink);

          if (format === "plain") {
            write(`\n# Asking ${selectedExpert.displayName} (${selectedExpert.slug})\n`);
            write(`Panel: ${panel.name}\n`);
            write(`Question: ${question}\n\n`);
          }

          const stream = persister.persist(
            new Debate(engine, [expertSpec], config).run(question),
            question,
          );
          await renderer.render(stream);
        } catch (err: unknown) {
          writeError("\n" + formatEngineError(err as Error) + "\n\n");
          throw err;
        }
      } finally {
        if (engine) {
          await engine.stop().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            writeError(`!! engine.stop() failed during cleanup: ${msg}\n`);
          });
        }
        await db.destroy().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          writeError(`!! db.destroy() failed during cleanup: ${msg}\n`);
        });
      }
    });

  return cmd;
}
