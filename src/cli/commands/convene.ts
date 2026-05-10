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
import type { DebateMode } from "../../core/template-loader.js";
import { loadTemplate, type PanelDefinition } from "../../core/template-loader.js";
import { buildSystemPrompt } from "../../core/prompt-builder.js";
import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import { createDatabase } from "../../memory/db.js";
import { ExpertRepository } from "../../memory/repositories/experts.js";
import { PanelRepository } from "../../memory/repositories/panels.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";
import {
  ENGINE_KINDS,
  type EngineKind,
  makeEngineFromKind,
  runWithEngine,
} from "../run-with-engine.js";

const DEFAULT_MAX_ROUNDS = 4;
const DEFAULT_MAX_WORDS = 250;

export { ENGINE_KINDS as CONVENE_ENGINE_KINDS };
export type ConveneEngineKind = EngineKind;

export interface ConveneCommandDeps {
  readonly engineFactory?: () => CouncilEngine;
  readonly write?: Writer;
  readonly writeError?: Writer;
}

export interface ConveneOptions {
  readonly template: string;
  readonly format: "json" | "plain";
  readonly maxRounds: number;
  readonly mode: DebateMode;
  readonly maxWords: number;
  readonly engine: EngineKind;
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
    .option("--format <kind>", "Output format: json (NDJSON) or plain (human)", "plain")
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
    .action(async (topic: string, raw: ConveneOptions) => {
      if (!ENGINE_KINDS.includes(raw.engine)) {
        throw new Error(
          `Unknown --engine value: ${raw.engine}. Expected one of: ${ENGINE_KINDS.join(", ")}`,
        );
      }

      const opts: ConveneOptions = {
        template: raw.template,
        format: raw.format === "json" ? "json" : "plain",
        maxRounds: Number.isFinite(raw.maxRounds) ? raw.maxRounds : DEFAULT_MAX_ROUNDS,
        mode: raw.mode === "structured" ? "structured" : "freeform",
        maxWords: Number.isFinite(raw.maxWords) ? raw.maxWords : DEFAULT_MAX_WORDS,
        engine: raw.engine,
      };

      if (opts.engine === "mock") {
        writeError(
          "\n!! [MOCK ENGINE] Running with deterministic offline mock — responses are NOT real.\n" +
            "   This debate will be persisted to the local DB tagged engine='mock'.\n\n",
        );
      }

      const template = await loadTemplate(opts.template);
      const experts = buildExpertSpecs(template, topic);

      const dbPath = path.join(getCouncilHome(), "council.db");
      const db = await createDatabase(dbPath);
      try {
        const panelRepo = new PanelRepository(db);
        const expertRepo = new ExpertRepository(db);

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
        for (const e of experts) {
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
          experts,
          debateConfig: {
            maxRounds: opts.maxRounds,
            maxWordsPerResponse: opts.maxWords,
            mode: opts.mode,
          },
          prompt: topic,
          panelId: panel.id,
          expertSlugToId,
          moderator: opts.mode === "structured" ? "structured-phases" : "round-robin",
          format: opts.format,
          write,
          writeError,
          db,
          preamble:
            opts.format === "plain"
              ? () => {
                  write(`\n# ${template.name}\n`);
                  write(`Topic: ${topic}\n`);
                  write(`Mode: ${opts.mode} | Max rounds: ${opts.maxRounds} | Engine: ${opts.engine}\n\n`);
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

function buildExpertSpecs(template: PanelDefinition, topic: string): ExpertSpec[] {
  return template.experts.map((def) => {
    const systemMessage = buildSystemPrompt(def, undefined, topic);
    return {
      id: ulid(),
      slug: def.slug,
      displayName: def.displayName,
      model: def.model ?? DEFAULT_MODEL,
      systemMessage,
    };
  });
}
