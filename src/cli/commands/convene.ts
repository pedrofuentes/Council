/**
 * `council convene <topic> --template <name>` — runs a full panel debate
 * end-to-end and persists the result to the local SQLite DB.
 *
 * Wiring:
 *   1. Load + validate the panel template (panels/<name>.yaml)
 *   2. Build the 8-section system prompt for each expert (no memory recall yet)
 *   3. Open the local DB; insert panel + expert rows
 *   4. Construct the engine via the injected factory (default = Copilot adapter)
 *   5. Register experts with the engine
 *   6. Build a Debate, wrap with DebatePersister, hand to selected Renderer
 *   7. Render until debate.end; clean up engine + DB; return
 *
 * The `engineFactory` and `write` options exist purely for testability —
 * production callers omit them and get the Copilot engine + stdout writer.
 *
 * Memory recall (§3.1 second half) is NOT yet wired here; experts are
 * built with `memory: undefined`. Once recall lands the only change is
 * to pass a populated ExpertMemory into buildSystemPrompt.
 */
import * as path from "node:path";
import { ulid } from "ulid";

import { Command } from "commander";

import { getCouncilHome } from "../../config/index.js";
import { Debate, type DebateConfig } from "../../core/debate.js";
import {
  loadTemplate,
  type DebateMode,
  type PanelDefinition,
} from "../../core/template-loader.js";
import { buildSystemPrompt } from "../../core/prompt-builder.js";
import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import { MockEngine } from "../../engine/mock/mock-engine.js";
import { createDatabase } from "../../memory/db.js";
import { ExpertRepository } from "../../memory/repositories/experts.js";
import { PanelRepository } from "../../memory/repositories/panels.js";
import { DebateRepository } from "../../memory/repositories/debates.js";
import { TurnRepository } from "../../memory/repositories/turns.js";
import { DebatePersister } from "../../memory/persister.js";

import { JsonRenderer } from "../renderers/json.js";
import { PlainRenderer } from "../renderers/plain.js";
import type { Sink } from "../renderers/types.js";

import { defaultWriter, type Writer } from "./writer.js";

const DEFAULT_MODEL = "claude-sonnet-4";
const DEFAULT_MAX_ROUNDS = 4;
const DEFAULT_MAX_WORDS = 250;

export interface ConveneCommandDeps {
  /**
   * Engine factory. Default constructs a fresh MockEngine — production
   * binaries override this to construct CopilotEngine. Tests inject a
   * MockEngine with seeded responses.
   *
   * Default is MockEngine (not Copilot) because importing the Copilot
   * adapter at module load would force every CLI consumer to ship the SDK
   * even for non-convene commands. The bin entry will be updated in a
   * follow-up to inject the real adapter once it has a session pool.
   */
  readonly engineFactory?: () => CouncilEngine;
  /** Writer for stdout. Defaults to process.stdout.write. */
  readonly write?: Writer;
  /** Pass-through to commander.Command#exitOverride for tests. */
  readonly exitOverride?: boolean;
}

export interface ConveneOptions {
  readonly template: string;
  readonly format: "json" | "plain";
  readonly maxRounds: number;
  readonly mode: DebateMode;
  readonly maxWords: number;
}

function defaultEngineFactory(): CouncilEngine {
  // Per docs above — production wiring lives in bin/council.ts.
  return new MockEngine();
}

export function buildConveneCommand(deps: ConveneCommandDeps = {}): Command {
  const write: Writer = deps.write ?? defaultWriter;
  const engineFactory = deps.engineFactory ?? defaultEngineFactory;

  const cmd = new Command("convene");
  cmd
    .description("Run a panel debate on a topic and persist results to the local DB")
    .argument("<topic>", "The topic / question for the panel to debate")
    .requiredOption("--template <name>", "Built-in panel template (e.g. 'code-review')")
    .option("--format <kind>", "Output format: json (NDJSON) or plain (human)", "plain")
    .option("--max-rounds <n>", "Max rounds (freeform mode only)", (v) => Number.parseInt(v, 10), DEFAULT_MAX_ROUNDS)
    .option("--mode <kind>", "Debate mode: freeform | structured", "freeform")
    .option(
      "--max-words <n>",
      "Soft per-response word cap",
      (v) => Number.parseInt(v, 10),
      DEFAULT_MAX_WORDS,
    )
    .action(async (topic: string, raw: ConveneOptions) => {
      const opts: ConveneOptions = {
        template: raw.template,
        format: raw.format === "json" ? "json" : "plain",
        maxRounds: Number.isFinite(raw.maxRounds) ? raw.maxRounds : DEFAULT_MAX_ROUNDS,
        mode: raw.mode === "structured" ? "structured" : "freeform",
        maxWords: Number.isFinite(raw.maxWords) ? raw.maxWords : DEFAULT_MAX_WORDS,
      };

      // (1) Load template — throws if not found / invalid.
      const template = await loadTemplate(opts.template);

      // (2) Build expert specs (8-section prompts).
      const experts = buildExpertSpecs(template, topic);

      // (3) Open DB; insert panel + expert rows.
      const dbPath = path.join(getCouncilHome(), "council.db");
      const db = await createDatabase(dbPath);
      let engine: CouncilEngine | undefined;
      try {
        const panelRepo = new PanelRepository(db);
        const expertRepo = new ExpertRepository(db);
        const debateRepo = new DebateRepository(db);
        const turnRepo = new TurnRepository(db);

        const panel = await panelRepo.create({
          name: `${template.name}-${new Date().toISOString().slice(0, 19)}`,
          topic,
          copilotHome: path.join(getCouncilHome(), "copilot"),
          configJson: JSON.stringify({
            template: template.name,
            mode: opts.mode,
            maxRounds: opts.maxRounds,
            maxWords: opts.maxWords,
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

        // (4) Construct engine + register experts.
        engine = engineFactory();
        await engine.start();
        for (const e of experts) {
          await engine.addExpert(e);
        }

        // (5) Build Debate + wrap in persister + hand to renderer.
        const config: DebateConfig = {
          maxRounds: opts.maxRounds,
          maxWordsPerResponse: opts.maxWords,
          mode: opts.mode,
        };
        const persister = new DebatePersister({
          debates: debateRepo,
          turns: turnRepo,
          panelId: panel.id,
          expertSlugToId,
          moderator: opts.mode === "structured" ? "structured-phases" : "round-robin",
        });

        const sink: Sink = {
          write,
          writeError: write,
        };
        const renderer =
          opts.format === "json" ? new JsonRenderer(sink) : new PlainRenderer(sink);

        // Plain renderer benefits from a human-readable header so the user
        // sees what panel/topic is running before any expert turn streams.
        // JSON output stays pure NDJSON (machine-readable, no preamble).
        if (opts.format === "plain") {
          write(`\n# ${template.name}\n`);
          write(`Topic: ${topic}\n`);
          write(`Mode: ${opts.mode} | Max rounds: ${opts.maxRounds}\n\n`);
        }

        const stream = persister.persist(new Debate(engine, experts, config).run(topic), topic);
        await renderer.render(stream);
      } finally {
        if (engine) await engine.stop().catch(() => undefined);
        await db.destroy().catch(() => undefined);
      }
    });

  if (deps.exitOverride) cmd.exitOverride();
  return cmd;
}

/**
 * Build runtime ExpertSpec[] from a validated template, rendering each
 * expert's full 8-section system prompt. The `task` slot of the prompt
 * is the user's topic — phase-specific tasks come later via per-turn
 * prompts emitted by the Debate orchestrator (no second prompt build
 * needed; those are sent as the user message, not the system one).
 */
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
