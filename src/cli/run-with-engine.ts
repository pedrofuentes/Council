/**
 * Shared engine-lifecycle helper — encapsulates the boilerplate that
 * `convene`, `resume --continue`, and `ask` all need:
 *
 *   1. Construct the engine (via factory or kind → constructor)
 *   2. Start it
 *   3. Register experts (Promise.allSettled + fulfilled-only rollback)
 *   4. Build Debate + wrap in DebatePersister + render
 *   5. On engine error: write actionable hint via formatEngineError
 *   6. In finally: stop engine + destroy DB (log cleanup errors)
 *
 * Extracted per Sentinel pr192 #193 (rule-of-three duplication across
 * the three commands). Each command becomes a thin wrapper that
 * resolves the panel/experts/template, builds the `RunWithEngineOpts`,
 * and calls this function.
 *
 * This module does NOT import `@github/copilot-sdk` — it accepts an
 * engine factory or constructs via the `makeEngineFromKind` helper
 * (which itself imports from the engine layer, not the SDK directly).
 */
import { Debate, type DebateConfig } from "../core/debate.js";
import type { CouncilEngine, ExpertSpec } from "../engine/index.js";
import { MockEngine } from "../engine/mock/mock-engine.js";
import { CopilotEngine } from "../engine/copilot/adapter.js";
import type { CouncilDatabase } from "../memory/db.js";
import { DebateRepository } from "../memory/repositories/debates.js";
import { TurnRepository } from "../memory/repositories/turns.js";
import { DebatePersister } from "../memory/persister.js";

import { JsonRenderer } from "./renderers/json.js";
import { PlainRenderer } from "./renderers/plain.js";
import type { Sink } from "./renderers/types.js";

import { formatEngineError } from "./error-mapper.js";
import type { Writer } from "./commands/writer.js";

export const ENGINE_KINDS = ["mock", "copilot"] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];

export function makeEngineFromKind(kind: EngineKind): CouncilEngine {
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

export interface RunWithEngineOpts {
  /** Engine kind (used when engineFactory is not provided). */
  readonly engineKind: EngineKind;
  /** Test-only override: takes precedence over engineKind. */
  readonly engineFactory?: (() => CouncilEngine) | undefined;
  /** Experts to register with the engine and feed into the debate. */
  readonly experts: readonly ExpertSpec[];
  /** Debate configuration (maxRounds, maxWordsPerResponse, mode, retryBackoffMs). */
  readonly debateConfig: DebateConfig;
  /** The user's prompt / topic. */
  readonly prompt: string;
  /** Panel ID for the DebatePersister. */
  readonly panelId: string;
  /** Maps expert slug → expert DB id for the DebatePersister. */
  readonly expertSlugToId: Readonly<Record<string, string>>;
  /** Moderator label written to the debate row. */
  readonly moderator: string;
  /** Output format for the renderer. */
  readonly format: "json" | "plain";
  /** stdout writer. */
  readonly write: Writer;
  /** stderr writer. */
  readonly writeError: Writer;
  /** Open database handle — caller manages creation; this function does NOT destroy it. */
  readonly db: CouncilDatabase;
  /**
   * Optional preamble to write before the debate stream starts. Called
   * after engine init succeeds but before the first event. Useful for
   * plain-mode headers (e.g. "# panel-name\nTopic: ...\n").
   */
  readonly preamble?: (() => void) | undefined;
}

/**
 * Run a full debate lifecycle: engine init → addExpert → stream →
 * persist → render → stop. Caller handles DB open/close and panel
 * resolution; this function owns the engine lifecycle.
 *
 * On engine errors: writes actionable hint via `formatEngineError`
 * to `writeError` before re-throwing.
 *
 * On cleanup errors (engine.stop): writes diagnostic to `writeError`
 * but does NOT re-throw (cleanup is best-effort; the main operation
 * already succeeded or failed).
 */
export async function runWithEngine(opts: RunWithEngineOpts): Promise<void> {
  const engine = opts.engineFactory
    ? opts.engineFactory()
    : makeEngineFromKind(opts.engineKind);

  try {
    await engine.start();

    // Leak-safe parallel addExpert (Sentinel #142 + #151).
    const startedEngine = engine;
    const settled = await Promise.allSettled(
      opts.experts.map((e) => startedEngine.addExpert(e)),
    );
    const failures = settled
      .map((r, i) => ({ result: r, expert: opts.experts[i] }))
      .filter(
        (p): p is { result: PromiseRejectedResult; expert: ExpertSpec } =>
          p.result.status === "rejected" && p.expert !== undefined,
      );
    if (failures.length > 0) {
      const fulfilledIds = settled
        .map((r, i) => ({ result: r, expert: opts.experts[i] }))
        .filter(
          (p): p is { result: PromiseFulfilledResult<void>; expert: ExpertSpec } =>
            p.result.status === "fulfilled" && p.expert !== undefined,
        )
        .map((p) => p.expert.id);
      await Promise.allSettled(
        fulfilledIds.map((id) => startedEngine.removeExpert(id)),
      );
      const firstErr = failures[0]?.result.reason;
      const firstMsg =
        firstErr instanceof Error ? firstErr.message : String(firstErr);
      throw new Error(
        `could not register all experts (${failures.length}/${opts.experts.length} failed): ${firstMsg}`,
      );
    }

    // Persist + render.
    const persister = new DebatePersister({
      debates: new DebateRepository(opts.db),
      turns: new TurnRepository(opts.db),
      panelId: opts.panelId,
      expertSlugToId: opts.expertSlugToId,
      moderator: opts.moderator,
    });

    const sink: Sink = { write: opts.write, writeError: opts.writeError };
    const renderer =
      opts.format === "json"
        ? new JsonRenderer(sink)
        : new PlainRenderer(sink);

    opts.preamble?.();

    const stream = persister.persist(
      new Debate(engine, opts.experts, opts.debateConfig).run(opts.prompt),
      opts.prompt,
    );
    await renderer.render(stream);
  } catch (err: unknown) {
    opts.writeError("\n" + formatEngineError(err as Error) + "\n\n");
    throw err;
  } finally {
    await engine.stop().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      opts.writeError(`!! engine.stop() failed during cleanup: ${msg}\n`);
    });
  }
}
