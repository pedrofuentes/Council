/**
 * `council resume <panel> [--continue "<prompt>"]` — reopens a panel
 * that already has at least one persisted debate (ROADMAP §3.2).
 *
 * Two modes:
 *
 *   1. **Transcript mode** (no --continue) — replays the most recent
 *      debate's turns as a synthesized DebateEvent stream and hands
 *      it to the chosen renderer. The events are reconstructed from
 *      DB rows; no engine is constructed, no LLM calls are made.
 *
 *   2. **Continue mode** (with --continue "<prompt>") — runs a NEW
 *      debate against the same panel/experts using the existing
 *      convene wiring (engine + Debate + DebatePersister + Renderer).
 *      Reuses the panel's stored expert system prompts verbatim — no
 *      memory recall yet (§3.1 second half).
 *
 * Out of scope for this PR:
 *   - Mid-debate resume (would need stable Copilot resumeSession)
 *   - Interactive panel picker (deferred to ink-ui §3.4)
 *   - Memory recall into prompts
 *
 * Engine selection mirrors convene: `--engine mock|copilot` required
 * in continue mode (irrelevant in transcript mode — no engine used).
 */
import * as path from "node:path";

import { Command } from "commander";

import { getCouncilHome } from "../../config/index.js";
import { Debate, type DebateConfig } from "../../core/debate.js";
import type {
  DebateEvent,
  DebateEndReason,
  PanelMemberSnapshot,
} from "../../core/types.js";
import type { CouncilEngine, ExpertSpec } from "../../engine/index.js";
import { MockEngine } from "../../engine/mock/mock-engine.js";
import { CopilotEngine } from "../../engine/copilot/adapter.js";
import { createDatabase, type CouncilDatabase } from "../../memory/db.js";
import { DebateRepository, type DebateStatus } from "../../memory/repositories/debates.js";
import { ExpertRepository, type Expert } from "../../memory/repositories/experts.js";
import { PanelRepository, type Panel } from "../../memory/repositories/panels.js";
import { TurnRepository, type Turn } from "../../memory/repositories/turns.js";
import { DebatePersister } from "../../memory/persister.js";

import { JsonRenderer } from "../renderers/json.js";
import { PlainRenderer } from "../renderers/plain.js";
import type { Sink } from "../renderers/types.js";

import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";

const DEFAULT_MAX_ROUNDS = 4;
const DEFAULT_MAX_WORDS = 250;
const RESUME_ENGINE_KINDS = ["mock", "copilot"] as const;
type ResumeEngineKind = (typeof RESUME_ENGINE_KINDS)[number];

export interface ResumeCommandDeps {
  /**
   * Test-only override: takes precedence over the --engine flag and
   * constructs the engine directly. Production callers omit this.
   */
  readonly engineFactory?: () => CouncilEngine;
  readonly write?: Writer;
  readonly writeError?: Writer;
}

export interface ResumeOptions {
  readonly format: "json" | "plain";
  readonly continue?: string;
  readonly engine: ResumeEngineKind;
  readonly maxRounds: number;
  readonly maxWords: number;
}

interface ResolvedDebate {
  readonly panel: Panel;
  readonly experts: readonly Expert[];
  readonly latestDebate: { id: string; prompt: string; status: DebateStatus };
  readonly turns: readonly Turn[];
}

function makeEngineFromKind(kind: ResumeEngineKind): CouncilEngine {
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

function reasonFromStatus(status: DebateStatus): DebateEndReason {
  switch (status) {
    case "completed":
      return "completed";
    case "aborted":
      return "aborted";
    case "failed":
      return "failed";
    case "running":
      // The persisted debate was abandoned mid-stream (no terminal
      // event ever fired). Surface as "aborted" to the renderer so
      // the consumer can distinguish from cleanly completed.
      return "aborted";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function buildResumeCommand(deps: ResumeCommandDeps = {}): Command {
  const write: Writer = deps.write ?? defaultWriter;
  const writeError: Writer = deps.writeError ?? defaultErrorWriter;

  const cmd = new Command("resume");
  cmd
    .description("Reopen a panel: show transcript, or continue with a new prompt")
    .argument("<panel>", "Panel name to resume (as shown by `council panels`)")
    .option("--format <kind>", "Output format: json (NDJSON) or plain (human)", "plain")
    .option(
      "--continue <prompt>",
      "Run a new debate against the same panel with this prompt",
    )
    .option(
      "--engine <kind>",
      "Engine for --continue mode: 'mock' (offline) or 'copilot' (real)",
      "mock",
    )
    .option(
      "--max-rounds <n>",
      "Max rounds for --continue mode",
      (v) => Number.parseInt(v, 10),
      DEFAULT_MAX_ROUNDS,
    )
    .option(
      "--max-words <n>",
      "Soft per-response word cap for --continue mode",
      (v) => Number.parseInt(v, 10),
      DEFAULT_MAX_WORDS,
    )
    .action(async (panelName: string, raw: ResumeOptions) => {
      const opts: ResumeOptions = {
        format: raw.format === "json" ? "json" : "plain",
        ...(raw.continue !== undefined ? { continue: raw.continue } : {}),
        engine: RESUME_ENGINE_KINDS.includes(raw.engine) ? raw.engine : "mock",
        maxRounds: Number.isFinite(raw.maxRounds) ? raw.maxRounds : DEFAULT_MAX_ROUNDS,
        maxWords: Number.isFinite(raw.maxWords) ? raw.maxWords : DEFAULT_MAX_WORDS,
      };

      const dbPath = path.join(getCouncilHome(), "council.db");
      const db = await createDatabase(dbPath);
      let engine: CouncilEngine | undefined;
      try {
        const resolved = await resolvePanel(db, panelName);

        if (opts.continue === undefined) {
          // Transcript mode — replay persisted events through the renderer.
          await renderTranscript(resolved, opts.format, write);
          return;
        }

        // Continue mode — run a new debate against the same panel.
        if (opts.engine === "mock") {
          writeError(
            "\n!! [MOCK ENGINE] --continue running with deterministic offline mock — responses are NOT real.\n\n",
          );
        }

        const debateRepo = new DebateRepository(db);
        const turnRepo = new TurnRepository(db);

        const expertSpecs = resolved.experts.map<ExpertSpec>((e) => ({
          id: e.id,
          slug: e.slug,
          displayName: e.displayName,
          model: e.model,
          systemMessage: e.systemMessage,
        }));

        engine = deps.engineFactory ? deps.engineFactory() : makeEngineFromKind(opts.engine);
        await engine.start();
        const startedEngine = engine;
        const settled = await Promise.allSettled(
          expertSpecs.map((e) => startedEngine.addExpert(e)),
        );
        const failures = settled.filter((r) => r.status === "rejected");
        if (failures.length > 0) {
          const fulfilledIds = settled
            .map((r, i) => ({ result: r, expert: expertSpecs[i] }))
            .filter(
              (p): p is { result: PromiseFulfilledResult<void>; expert: ExpertSpec } =>
                p.result.status === "fulfilled" && p.expert !== undefined,
            )
            .map((p) => p.expert.id);
          await Promise.allSettled(
            fulfilledIds.map((id) => startedEngine.removeExpert(id)),
          );
          const firstErr = (failures[0] as PromiseRejectedResult).reason;
          const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
          throw new Error(
            `could not register all experts (${failures.length}/${expertSpecs.length} failed): ${firstMsg}`,
          );
        }

        const expertSlugToId: Record<string, string> = {};
        for (const e of resolved.experts) expertSlugToId[e.slug] = e.id;

        const config: DebateConfig = {
          maxRounds: opts.maxRounds,
          maxWordsPerResponse: opts.maxWords,
          mode: "freeform",
        };
        const persister = new DebatePersister({
          debates: debateRepo,
          turns: turnRepo,
          panelId: resolved.panel.id,
          expertSlugToId,
          moderator: "round-robin",
        });

        const sink: Sink = { write, writeError };
        const renderer =
          opts.format === "json" ? new JsonRenderer(sink) : new PlainRenderer(sink);

        if (opts.format === "plain") {
          write(`\n# Continuing ${resolved.panel.name}\n`);
          write(`Prompt: ${opts.continue}\n`);
          write(`Engine: ${opts.engine} | Max rounds: ${opts.maxRounds}\n\n`);
        }

        const stream = persister.persist(
          new Debate(engine, expertSpecs, config).run(opts.continue),
          opts.continue,
        );
        await renderer.render(stream);
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

/**
 * Look up the panel by name + load its experts + the most recent debate
 * + that debate's turns. Throws a clear error if the panel doesn't exist.
 */
async function resolvePanel(db: CouncilDatabase, panelName: string): Promise<ResolvedDebate> {
  const panelRepo = new PanelRepository(db);
  const expertRepo = new ExpertRepository(db);
  const debateRepo = new DebateRepository(db);
  const turnRepo = new TurnRepository(db);

  const panel = await panelRepo.findByName(panelName);
  if (!panel) {
    throw new Error(`No panel found with name '${panelName}'. Run \`council panels\` to list available panels.`);
  }
  const experts = await expertRepo.findByPanelId(panel.id);
  const debates = await debateRepo.findByPanelId(panel.id);
  if (debates.length === 0) {
    throw new Error(`Panel '${panelName}' has no debates yet. Run \`council convene\` to start one.`);
  }
  // findByPanelId orders by startedAt ASC, ID ASC — most recent is last.
  const latest = debates[debates.length - 1];
  if (!latest) {
    throw new Error(`Panel '${panelName}' has no debates yet. Run \`council convene\` to start one.`);
  }
  const turns = await turnRepo.findByDebateId(latest.id);
  return {
    panel,
    experts,
    latestDebate: { id: latest.id, prompt: latest.prompt, status: latest.status },
    turns,
  };
}

/**
 * Synthesize a DebateEvent stream from persisted DB rows and feed it
 * through the renderer. No engine, no LLM. Useful for read-only review.
 */
async function renderTranscript(
  resolved: ResolvedDebate,
  format: "json" | "plain",
  write: Writer,
): Promise<void> {
  const slugById = new Map<string, string>();
  const nameBySlug = new Map<string, string>();
  for (const e of resolved.experts) {
    slugById.set(e.id, e.slug);
    nameBySlug.set(e.slug, e.displayName);
  }

  if (format === "plain") {
    write(`\n# ${resolved.panel.name}\n`);
    if (resolved.panel.topic) write(`Topic: ${resolved.panel.topic}\n`);
    write(`Prompt: ${resolved.latestDebate.prompt}\n`);
    write(`Status: ${resolved.latestDebate.status}\n\n`);
    for (const t of resolved.turns) {
      const slug = t.expertId ? slugById.get(t.expertId) : undefined;
      const display = slug ? (nameBySlug.get(slug) ?? slug) : t.speakerKind;
      write(`${display} (round ${t.round}, seq ${t.seq}):\n`);
      write(`  ${t.content}\n\n`);
    }
    write(`--- end of transcript (${resolved.turns.length} turns) ---\n`);
    return;
  }

  // JSON mode — synthesize and stream events.
  const members: PanelMemberSnapshot[] = resolved.experts.map((e) => ({
    slug: e.slug,
    displayName: e.displayName,
    model: e.model,
  }));
  const events: DebateEvent[] = [];
  events.push({ kind: "panel.assembled", experts: members });
  let lastRound = -1;
  for (const t of resolved.turns) {
    if (t.round !== lastRound) {
      if (lastRound !== -1) events.push({ kind: "round.end", round: lastRound });
      events.push({ kind: "round.start", round: t.round });
      lastRound = t.round;
    }
    const slug = t.expertId ? (slugById.get(t.expertId) ?? "unknown") : t.speakerKind;
    events.push({
      kind: "turn.start",
      expertSlug: slug,
      round: t.round,
      seq: t.seq,
    });
    events.push({
      kind: "turn.end",
      expertSlug: slug,
      turnId: t.id,
      content: t.content,
    });
  }
  if (lastRound !== -1) events.push({ kind: "round.end", round: lastRound });
  events.push({
    kind: "debate.end",
    reason: reasonFromStatus(resolved.latestDebate.status),
  });

  for (const e of events) {
    write(JSON.stringify(e) + "\n");
  }
}
