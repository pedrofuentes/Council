/**
 * Shared engine-lifecycle helper — encapsulates the boilerplate that
 * `convene`, `resume --prompt`, and `ask` all need:
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
import type { HumanInputProvider } from "../core/human-input.js";
import type { CouncilEngine, ExpertSpec } from "../engine/index.js";
import { createEngine, PROVIDER_IDS, type ProviderId } from "../engine/providers.js";
import type { CouncilDatabase } from "../memory/db.js";
import { DebateRepository } from "../memory/repositories/debates.js";
import { TurnRepository } from "../memory/repositories/turns.js";
import { DebatePersister } from "../memory/persister.js";

import { PlainRenderer } from "./renderers/plain.js";
import { selectRenderer, type RendererFormat } from "./renderers/select.js";
import type { Sink } from "./renderers/types.js";

import { formatEngineError } from "./error-mapper.js";
import type { Writer } from "./commands/writer.js";

/**
 * CLI-facing engine kinds — the choices offered by every `--engine` option.
 * Sourced from the provider registry so the CLI and the registry can never
 * drift: available providers (copilot/mock) construct; coming-soon ones
 * (openai/anthropic) are selectable but yield a graceful "not yet
 * available" error at construction time.
 */
export const ENGINE_KINDS = PROVIDER_IDS;
export type EngineKind = ProviderId;

/**
 * Construct an engine from a CLI engine kind by delegating to the provider
 * registry (the single source of truth for provider → factory). Coming-soon
 * providers throw a graceful {@link ProviderNotAvailableError}; unknown
 * kinds throw "Unknown engine kind".
 */
export function makeEngineFromKind(kind: EngineKind): CouncilEngine {
  return createEngine(kind);
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
  /**
   * Output format for the renderer:
   *   - "json"  → NDJSON (always, regardless of TTY)
   *   - "plain" → plain text (always, regardless of TTY)
   *   - "auto"  → Ink TUI on TTY, plain text otherwise
   */
  readonly format: RendererFormat;
  /** stdout writer. */
  readonly write: Writer;
  /** stderr writer. */
  readonly writeError: Writer;
  /**
   * Test override for TTY detection. Defaults to `process.stdout.isTTY`.
   * Only consulted when `format === "auto"`.
   */
  readonly isTTY?: boolean;
  /** Suppress informational output like cost counters. Defaults to false. */
  readonly quiet?: boolean;
  /** Open database handle — caller manages creation; this function does NOT destroy it. */
  readonly db: CouncilDatabase;
  /**
   * Optional AbortSignal forwarded to {@link Debate.run}. When the
   * signal aborts, the debate stops at the next turn boundary and
   * emits a terminal `debate.end` event with `reason: "aborted"`. A
   * pre-aborted signal short-circuits before any turn runs. Used by
   * `convene` to wire Ctrl+C (SIGINT) to a graceful debate stop
   * (issue #T6).
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * Optional preamble to write before the debate stream starts. Only
   * called when the chosen renderer is the plain-text renderer (Ink
   * and JSON manage their own framing).
   */
  readonly preamble?: (() => void) | undefined;
  /**
   * Optional hook invoked after renderer selection but before any debate output is written.
   * Use this for stderr notices that must appear before JSON/plain debate streaming starts.
   */
  readonly beforeRender?: (() => void) | undefined;
  /** Slugs of human participants — skipped for engine registration. */
  readonly humanSlugs?: ReadonlySet<string> | undefined;
  /** Provider for collecting human input during debate. */
  readonly humanInput?: HumanInputProvider | undefined;
  /**
   * Optional post-debate hook. Invoked exactly once on a successful
   * debate, AFTER the renderer has finished streaming but BEFORE the
   * engine is stopped — so the hook can register temporary experts
   * (e.g. an LLM extractor) on the live engine.
   *
   * Errors thrown by the hook are caught and reported via
   * `writeError`; they do NOT propagate. The hook is not invoked
   * when the debate itself threw before the renderer finished.
   */
  readonly onDebateComplete?: ((ctx: OnDebateCompleteContext) => Promise<void>) | undefined;
}

/**
 * Context passed to {@link RunWithEngineOpts.onDebateComplete}. The
 * hook is invoked with the still-running engine; `debateId` is the
 * id of the row the DebatePersister created at the start of the
 * debate.
 */
export interface OnDebateCompleteContext {
  readonly engine: CouncilEngine;
  readonly db: CouncilDatabase;
  readonly panelId: string;
  readonly debateId: string;
  readonly expertSlugToId: Readonly<Record<string, string>>;
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
  const engine = opts.engineFactory ? opts.engineFactory() : makeEngineFromKind(opts.engineKind);

  try {
    await engine.start();

    const humanSlugs = opts.humanSlugs ?? new Set<string>();

    // Build the Debate first so canary tokens (T-09) are injected
    // into each expert's systemMessage. The augmented specs are then
    // registered with the engine via `debate.experts`, ensuring the
    // canary actually reaches the LLM — otherwise leak detection in
    // `#runAiTurn` would be meaningless.
    const debate = new Debate(engine, opts.experts, opts.debateConfig, {
      humanSlugs: humanSlugs.size > 0 ? humanSlugs : undefined,
      humanInput: opts.humanInput,
    });

    // Leak-safe parallel addExpert (Sentinel #142 + #151).
    // Filter out human participants — they don't register with the engine.
    const aiExperts = debate.experts.filter((e) => !humanSlugs.has(e.slug));
    const startedEngine = engine;
    const settled = await Promise.allSettled(aiExperts.map((e) => startedEngine.addExpert(e)));
    const failures = settled
      .map((r, i) => ({ result: r, expert: aiExperts[i] }))
      .filter(
        (p): p is { result: PromiseRejectedResult; expert: ExpertSpec } =>
          p.result.status === "rejected" && p.expert !== undefined,
      );
    if (failures.length > 0) {
      const fulfilledIds = settled
        .map((r, i) => ({ result: r, expert: aiExperts[i] }))
        .filter(
          (p): p is { result: PromiseFulfilledResult<void>; expert: ExpertSpec } =>
            p.result.status === "fulfilled" && p.expert !== undefined,
        )
        .map((p) => p.expert.id);
      await Promise.allSettled(fulfilledIds.map((id) => startedEngine.removeExpert(id)));
      const firstErr = failures[0]?.result.reason;
      const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      throw new Error(
        `could not register all experts (${failures.length}/${aiExperts.length} failed): ${firstMsg}`,
      );
    }

    // Persist + render.
    const persister = new DebatePersister({
      debates: new DebateRepository(opts.db),
      turns: new TurnRepository(opts.db),
      panelId: opts.panelId,
      expertSlugToId: opts.expertSlugToId,
      moderator: opts.moderator,
      logger: {
        warn: (message) => {
          opts.writeError(`!! ${message}\n`);
        },
      },
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    const sink: Sink = { write: opts.write, writeError: opts.writeError };
    const isTTY = opts.isTTY ?? Boolean(process.stdout.isTTY);
    const renderer = selectRenderer({
      format: opts.format,
      isTTY,
      sink,
      showCost: opts.engineKind !== "mock",
      ...(opts.quiet !== undefined ? { quiet: opts.quiet } : {}),
    });

    opts.beforeRender?.();

    // Preambles are plain-text headers; only emit them when the chosen
    // renderer is the plain renderer (Ink owns its own framing; JSON
    // streams must stay machine-parseable).
    if (renderer instanceof PlainRenderer) {
      opts.preamble?.();
    }

    const stream = persister.persist(
      debate.run(opts.prompt, opts.signal ? { signal: opts.signal } : {}),
      opts.prompt,
    );
    await renderer.render(stream);

    // Post-debate hook (e.g. LLM ExpertMemory extraction). Best-effort:
    // hook failures are reported but never propagate — the debate
    // succeeded and engine.stop must still run in the finally block.
    if (opts.onDebateComplete !== undefined && persister.debateId !== undefined) {
      try {
        await opts.onDebateComplete({
          engine,
          db: opts.db,
          panelId: opts.panelId,
          debateId: persister.debateId,
          expertSlugToId: opts.expertSlugToId,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        opts.writeError(`!! onDebateComplete hook failed: ${msg}\n`);
      }
    }
  } catch (err: unknown) {
    // #810: when the caller's signal is aborted, the error is a
    // side-effect of the intentional interrupt — suppress the
    // user-facing diagnostic and don't re-throw so callers'
    // `if (debateInterrupted)` check can show the friendly message.
    if (opts.signal?.aborted) {
      return;
    }
    opts.writeError("\n" + formatEngineError(err as Error) + "\n\n");
    throw err;
  } finally {
    await engine.stop().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      opts.writeError(`!! engine.stop() failed during cleanup: ${msg}\n`);
    });
  }
}
