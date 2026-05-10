/**
 * `council convene <topic> --template <name> --engine <kind>` — runs a full
 * panel debate end-to-end and persists the result to the local SQLite DB.
 *
 * Engine selection is EXPLICIT. There is no silent default — the user
 * must pass `--engine mock` (offline, deterministic, for testing) or
 * `--engine copilot` (real Copilot SDK). This is deliberate per Sentinel
 * pr125 cycle 1 finding 1: we never silently persist fake mock data as
 * a real "completed" debate.
 *
 * Wiring:
 *   1. Load + validate the panel template (panels/<name>.yaml)
 *   2. Build the 8-section system prompt for each expert (no memory recall yet)
 *   3. Open the local DB; insert panel + expert rows (configJson tags engine)
 *   4. Construct the engine via the explicit kind / injected factory
 *   5. Register experts with the engine
 *   6. Build a Debate, wrap with DebatePersister, hand to selected Renderer
 *   7. Render until debate.end; clean up engine + DB; return
 *
 * The `engineFactory` and `write` options exist purely for testability —
 * production callers omit them; the engine is selected from the --engine
 * flag and constructed by built-in factories.
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

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";

import { DEFAULT_MODEL } from "../../config/index.js";
import { CopilotEngine } from "../../engine/copilot/adapter.js";
import { formatEngineError } from "../error-mapper.js";

const DEFAULT_MAX_ROUNDS = 4;
const DEFAULT_MAX_WORDS = 250;

/** Supported engine kinds via the `--engine` CLI flag. */
export const CONVENE_ENGINE_KINDS = ["mock", "copilot"] as const;
export type ConveneEngineKind = (typeof CONVENE_ENGINE_KINDS)[number];

export interface ConveneCommandDeps {
  /**
   * Test-only override: takes precedence over the --engine flag and
   * constructs the engine directly. Production callers omit this and
   * the command uses one of the built-in kind→factory mappings.
   */
  readonly engineFactory?: () => CouncilEngine;
  /** Writer for stdout (event stream / plain output). Defaults to process.stdout.write. */
  readonly write?: Writer;
  /**
   * Writer for stderr (warnings, cleanup errors). Defaults to
   * process.stderr.write. Sentinel pr125 #127: separating these channels
   * keeps `--format json` output as pure NDJSON on stdout — warnings and
   * diagnostics never inline-corrupt the machine-readable stream.
   */
  readonly writeError?: Writer;
}

export interface ConveneOptions {
  readonly template: string;
  readonly format: "json" | "plain";
  readonly maxRounds: number;
  readonly mode: DebateMode;
  readonly maxWords: number;
  readonly engine: ConveneEngineKind;
}

/**
 * Maps an explicit engine kind to a constructor function.
 *
 * @internal Exported only so unit tests can verify wiring without
 *   instantiating sessions. Not part of the public stable API — the
 *   convene command is the supported integration point.
 */
export function makeEngineFromKind(kind: ConveneEngineKind): CouncilEngine {
  switch (kind) {
    case "mock":
      return new MockEngine();
    case "copilot":
      return new CopilotEngine();
    default: {
      // Sentinel pr132 #134 + pr125 #128: exhaustiveness check. If a
      // future ConveneEngineKind value is added without a matching case
      // here, this throws at runtime and the typed `_exhaustive`
      // assignment fails at compile time.
      const _exhaustive: never = kind;
      throw new Error(`Unknown engine kind: ${String(_exhaustive)}`);
    }
  }
}

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
      // Sentinel pr125 #129: validate-then-assign. No silent fallback.
      if (!CONVENE_ENGINE_KINDS.includes(raw.engine)) {
        throw new Error(
          `Unknown --engine value: ${raw.engine}. Expected one of: ${CONVENE_ENGINE_KINDS.join(", ")}`,
        );
      }
      const engineKind: ConveneEngineKind = raw.engine;

      const opts: ConveneOptions = {
        template: raw.template,
        format: raw.format === "json" ? "json" : "plain",
        maxRounds: Number.isFinite(raw.maxRounds) ? raw.maxRounds : DEFAULT_MAX_ROUNDS,
        mode: raw.mode === "structured" ? "structured" : "freeform",
        maxWords: Number.isFinite(raw.maxWords) ? raw.maxWords : DEFAULT_MAX_WORDS,
        engine: engineKind,
      };

      // Sentinel pr125 #127: route the MOCK warning through writeError
      // so JSON consumers reading stdout get pure NDJSON. Plain users
      // see both channels combined when both default to the terminal.
      if (opts.engine === "mock") {
        writeError(
          "\n!! [MOCK ENGINE] Running with deterministic offline mock — responses are NOT real.\n" +
            "   This debate will be persisted to the local DB tagged engine='mock'.\n\n",
        );
      }

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

        // (4) Construct engine. Test injection wins over the kind-based
        // factory so we don't have to mutate process.env to pass mocks.
        // Sentinel #133: wrap engine init + render in try/catch and route
        // engine errors through formatEngineError so users see actionable
        // hints (e.g. NOT_AUTHENTICATED → "run gh auth login") instead of
        // raw stack traces. Re-throw preserves existing test contracts.
        try {
          engine = deps.engineFactory ? deps.engineFactory() : makeEngineFromKind(opts.engine);
          await engine.start();

        // Sentinel #142: leak-safe parallel addExpert.
        // CopilotEngine creates one CopilotSession per expert independently
        // (no shared mutable state during creation), so Promise.allSettled
        // is safe and cuts startup latency from O(N × session-create-ms)
        // to O(1). We use allSettled instead of all so that one rejection
        // doesn't strand still-pending sessions: we wait for every call to
        // settle, then either continue (all fulfilled) or roll back the
        // successful registrations before re-throwing.
        const startedEngine = engine;
        const settled = await Promise.allSettled(
          experts.map((e) => startedEngine.addExpert(e)),
        );
        const failures = settled
          .map((r, i) => ({ result: r, expert: experts[i] }))
          .filter((p): p is { result: PromiseRejectedResult; expert: ExpertSpec } =>
            p.result.status === "rejected" && p.expert !== undefined,
          );
        if (failures.length > 0) {
          // Sentinel #151: roll back ONLY the experts whose addExpert
          // genuinely fulfilled. Sweeping the full list and relying on
          // removeExpert-is-idempotent-for-unknown-ids works today but
          // depends on an unverified contract; a future engine that
          // rejects on unknown ids would silently corrupt this rollback
          // path because Promise.allSettled swallows the errors.
          const fulfilledIds = settled
            .map((r, i) => ({ result: r, expert: experts[i] }))
            .filter(
              (p): p is { result: PromiseFulfilledResult<void>; expert: ExpertSpec } =>
                p.result.status === "fulfilled" && p.expert !== undefined,
            )
            .map((p) => p.expert.id);
          await Promise.allSettled(
            fulfilledIds.map((id) => startedEngine.removeExpert(id)),
          );
          const firstErr = failures[0]?.result.reason;
          const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
          throw new Error(
            `could not register all experts (${failures.length}/${experts.length} failed): ${firstMsg}`,
          );
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
          writeError,
        };
        const renderer =
          opts.format === "json" ? new JsonRenderer(sink) : new PlainRenderer(sink);

        // Plain renderer benefits from a human-readable header so the user
        // sees what panel/topic is running before any expert turn streams.
        // JSON output stays pure NDJSON (machine-readable, no preamble).
        if (opts.format === "plain") {
          write(`\n# ${template.name}\n`);
          write(`Topic: ${topic}\n`);
          write(`Mode: ${opts.mode} | Max rounds: ${opts.maxRounds} | Engine: ${opts.engine}\n\n`);
        }

        const stream = persister.persist(new Debate(engine, experts, config).run(topic), topic);
        await renderer.render(stream);
        } catch (err: unknown) {
          // Sentinel #133: surface actionable error hint via writeError.
          writeError("\n" + formatEngineError(err as Error) + "\n\n");
          throw err;
        }
      } finally {
        // Sentinel pr125 #130: log cleanup errors instead of swallowing.
        // Cleanup happens after the user already saw the main output, so
        // errors here go to writeError (stderr) — never block the success
        // path, but never silently lose info ops needs to debug.
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

