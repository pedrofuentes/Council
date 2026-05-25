/**
 * Ink-based renderer for the Council debate stream.
 *
 * `DebateApp` is a React component that consumes the `DebateEvent`
 * async iterable and renders a structured TTY UI:
 *
 *   - Panel roster on `panel.assembled`
 *   - Round header on `round.start`
 *   - Per-turn block: name (colored) + streaming body
 *   - Cost indicator (premium-request budget)
 *   - Errors in red
 *   - Retry indicator with spinner during `turn.retry`
 *   - Completion message on `debate.end`
 *
 * Uses Ink's `<Static>` component so completed turns render once and are
 * never re-reconciled — giving ~10× performance on long debates.
 *
 * `InkRenderer` is the `Renderer` adapter the CLI uses — it mounts
 * `DebateApp` via `ink.render()` and resolves when the stream ends.
 *
 * Selection between Ink, Plain, and JSON renderers lives in
 * `../select.ts` (Ink is auto-selected on TTY when the user does not
 * pass `--format`).
 */
import { useEffect, useState, type ReactElement } from "react";
import { Box, Static, Text, render as inkRender, useInput, useStdin } from "ink";
import Spinner from "ink-spinner";

import type { DebateEndReason, DebateEvent, PanelMemberSnapshot } from "../../../core/types.js";
import type { Renderer, Sink } from "../types.js";
import { PlainRenderer } from "../plain.js";

import { assignExpertColor, formatExpertPrefix, type ExpertColor } from "./colors.js";
import { getSymbols } from "../symbols.js";

/**
 * Wrapper that only mounts `useInput` when raw mode is supported.
 * Prevents errors in non-TTY environments (e.g. tests using inkRender directly).
 */
function CtrlCHandler({ onCancel }: { readonly onCancel: () => void }): null {
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      onCancel();
    }
  });
  return null;
}

/** Returns separator width: min(stdout columns, 100), default 80. */
export function getSeparatorWidth(): number {
  return Math.min(process.stdout.columns ?? 80, 100);
}

/** Returns max content width: min(stdout columns, 120), default 80. */
export function getContentWidth(): number {
  return Math.min(process.stdout.columns ?? 80, 120);
}

/**
 * Determine whether the streaming cursor should be suppressed.
 * Screen readers re-announce the cursor on every delta, so we hide it
 * when ASCII mode is active (NO_COLOR, COUNCIL_ASCII, TERM=dumb).
 */
export function shouldSuppressCursor(): boolean {
  if (process.env["NO_COLOR"]) return true;
  if (process.env["COUNCIL_ASCII"] === "1") return true;
  if (process.env["TERM"] === "dumb") return true;
  return false;
}

// --- Static list item types ---

interface StaticRoundHeader {
  readonly id: string;
  readonly type: "round-header";
  readonly round: number;
}

interface StaticTurn {
  readonly id: string;
  readonly type: "turn";
  readonly round: number;
  readonly expertSlug: string;
  readonly text: string;
}

interface StaticRoundSeparator {
  readonly id: string;
  readonly type: "round-separator";
}

type StaticItem = StaticRoundHeader | StaticTurn | StaticRoundSeparator;

// --- Active turn (streaming) ---

interface ActiveTurn {
  readonly round: number;
  readonly expertSlug: string;
  readonly text: string;
}

export interface DebateState {
  readonly panel: readonly PanelMemberSnapshot[];
  readonly expertIndex: ReadonlyMap<string, number>;
  readonly humanSlugs: ReadonlySet<string>;
  readonly displayNames: ReadonlyMap<string, string>;
  readonly currentRound: number | null;
  readonly completedItems: readonly StaticItem[];
  readonly activeTurn: ActiveTurn | null;
  readonly showCost: boolean;
  readonly cost: { readonly premiumRequests: number; readonly estimatedTotal: number } | null;
  readonly errors: readonly {
    readonly expertSlug?: string;
    readonly message: string;
    readonly recoverable: boolean;
  }[];
  readonly retrying: {
    readonly expertSlug: string;
    readonly attempt: number;
    readonly reason: string;
  } | null;
  readonly endReason: DebateEndReason | null;
  readonly userCancelled: boolean;
}

/** Exported for testing — initial empty state. */
export const INITIAL_STATE: DebateState = {
  panel: [],
  expertIndex: new Map(),
  humanSlugs: new Set(),
  displayNames: new Map(),
  currentRound: null,
  completedItems: [],
  activeTurn: null,
  showCost: true,
  cost: null,
  errors: [],
  retrying: null,
  endReason: null,
  userCancelled: false,
};

let nextId = 0;
function uid(prefix: string): string {
  return `${prefix}-${++nextId}`;
}

/** Exported for testing — state machine that drives the component. */
export function reduce(s: DebateState, ev: DebateEvent): DebateState {
  switch (ev.kind) {
    case "panel.assembled": {
      const expertIndex = new Map<string, number>();
      const displayNames = new Map<string, string>();
      const humanSlugs = new Set<string>();
      ev.experts.forEach((e, i) => {
        expertIndex.set(e.slug, i);
        displayNames.set(e.slug, e.displayName);
        if (e.participantKind === "human") humanSlugs.add(e.slug);
      });
      return { ...s, panel: ev.experts, expertIndex, displayNames, humanSlugs };
    }
    case "round.start": {
      // Seed the round header into completedItems so it renders in Static
      const header: StaticRoundHeader = {
        id: uid("rh"),
        type: "round-header",
        round: ev.round,
      };
      return {
        ...s,
        currentRound: ev.round,
        retrying: null,
        completedItems: [...s.completedItems, header],
      };
    }
    case "turn.start":
      return {
        ...s,
        activeTurn: { round: ev.round, expertSlug: ev.expertSlug, text: "" },
        retrying: null,
      };
    case "turn.delta": {
      if (s.activeTurn && s.activeTurn.expertSlug === ev.expertSlug) {
        return { ...s, activeTurn: { ...s.activeTurn, text: s.activeTurn.text + ev.text } };
      }
      // Orphan delta — start a new active turn
      return {
        ...s,
        activeTurn: { round: s.currentRound ?? 0, expertSlug: ev.expertSlug, text: ev.text },
      };
    }
    case "turn.end": {
      // Move active turn to completed; dismiss recoverable errors
      const text =
        s.activeTurn && s.activeTurn.expertSlug === ev.expertSlug && s.activeTurn.text.length > 0
          ? s.activeTurn.text
          : ev.content;
      const completedTurn: StaticTurn = {
        id: uid("t"),
        type: "turn",
        round: s.currentRound ?? 0,
        expertSlug: ev.expertSlug,
        text,
      };
      return {
        ...s,
        completedItems: [...s.completedItems, completedTurn],
        activeTurn: null,
        errors: s.errors.filter((e) => !e.recoverable),
      };
    }
    case "round.end": {
      const separator: StaticRoundSeparator = {
        id: uid("rs"),
        type: "round-separator",
      };
      return { ...s, completedItems: [...s.completedItems, separator] };
    }
    case "cost.update":
      if (!s.showCost) return s;
      return {
        ...s,
        cost: {
          premiumRequests: ev.premiumRequests,
          estimatedTotal: ev.estimatedTotal,
        },
      };
    case "debate.end":
      return { ...s, endReason: ev.reason, retrying: null };
    case "error":
      return {
        ...s,
        errors: [
          ...s.errors,
          {
            ...(ev.expertSlug !== undefined ? { expertSlug: ev.expertSlug } : {}),
            message: ev.message,
            recoverable: ev.recoverable,
          },
        ],
      };
    case "turn.retry":
      return {
        ...s,
        activeTurn: s.activeTurn ? { ...s.activeTurn, text: "" } : null,
        retrying: {
          expertSlug: ev.expertSlug,
          attempt: ev.attempt,
          reason: ev.reason,
        },
      };
    default: {
      const _exhaustive: never = ev;
      void _exhaustive;
      return s;
    }
  }
}

function colorFor(state: DebateState, slug: string): ExpertColor {
  const isHuman = state.humanSlugs.has(slug);
  return assignExpertColor(state.expertIndex.get(slug) ?? 0, { isHuman });
}

function nameFor(state: DebateState, slug: string): string {
  return state.displayNames.get(slug) ?? slug;
}

function PanelRoster({ state }: { readonly state: DebateState }): ReactElement | null {
  if (state.panel.length === 0) return null;
  const sym = getSymbols();
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{sym.panel} Panel assembled</Text>
      {state.panel.map((expert) => {
        const color = colorFor(state, expert.slug);
        const idx = state.expertIndex.get(expert.slug) ?? 0;
        const isHuman = expert.participantKind === "human" || state.humanSlugs.has(expert.slug);
        return (
          <Text key={expert.slug}>
            {`  ${sym.bullet} `}
            <Text color={color} bold>
              {formatExpertPrefix(idx, expert.displayName)}
            </Text>
            <Text dimColor>{isHuman ? "  (human)" : `  (${expert.model})`}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function RoundHeader({ round }: { readonly round: number }): ReactElement {
  const sym = getSymbols();
  return (
    <Box marginTop={1}>
      <Text bold>{`${sym.roundRule.repeat(3)} Round ${round + 1} ${sym.roundRule.repeat(3)}`}</Text>
    </Box>
  );
}

function RoundSeparator(): ReactElement {
  const width = getSeparatorWidth();
  return (
    <Box>
      <Text dimColor>{"─".repeat(width)}</Text>
    </Box>
  );
}

function ExpertCard({
  state,
  slug,
}: {
  readonly state: DebateState;
  readonly slug: string;
}): ReactElement {
  const color = colorFor(state, slug);
  const idx = state.expertIndex.get(slug) ?? 0;
  const isHuman = state.humanSlugs.has(slug);
  const name = nameFor(state, slug);
  const prefix = formatExpertPrefix(idx, name);
  const label = isHuman ? `[You] ${prefix}` : prefix;
  return (
    <Text>
      <Text color={color} bold>
        {`[${label}]`}
      </Text>
    </Text>
  );
}

function StreamingText({
  text,
  ended,
  retrying,
}: {
  readonly text: string;
  readonly ended: boolean;
  readonly retrying: boolean;
}): ReactElement {
  const sym = getSymbols();
  const showCursor = !ended && !retrying && text.length > 0 && !shouldSuppressCursor();
  return (
    <Text wrap="wrap">
      {text}
      {showCursor ? <Text color="cyan">{` ${sym.cursor}`}</Text> : null}
    </Text>
  );
}

/** Renders a single static item (round header, turn, or separator). */
function StaticItemView({
  item,
  state,
}: {
  readonly item: StaticItem;
  readonly state: DebateState;
}): ReactElement {
  switch (item.type) {
    case "round-header":
      return <RoundHeader round={item.round} />;
    case "round-separator":
      return <RoundSeparator />;
    case "turn":
      return (
        <Box flexDirection="column">
          <ExpertCard state={state} slug={item.expertSlug} />
          <StreamingText text={item.text} ended={true} retrying={false} />
        </Box>
      );
  }
}

function ActiveTurnView({ state }: { readonly state: DebateState }): ReactElement | null {
  if (!state.activeTurn) return null;
  return (
    <Box flexDirection="column">
      <ExpertCard state={state} slug={state.activeTurn.expertSlug} />
      <StreamingText
        text={state.activeTurn.text}
        ended={false}
        retrying={state.retrying !== null}
      />
    </Box>
  );
}

function RetryIndicator({ state }: { readonly state: DebateState }): ReactElement | null {
  if (!state.retrying) return null;
  const color = colorFor(state, state.retrying.expertSlug);
  return (
    <Box marginTop={1}>
      <Text color="yellow">
        <Spinner type="dots" />
      </Text>
      <Text>
        {" "}
        <Text color={color} bold>
          {nameFor(state, state.retrying.expertSlug)}
        </Text>
        <Text
          dimColor
        >{` retrying (attempt ${state.retrying.attempt}, ${state.retrying.reason})...`}</Text>
      </Text>
    </Box>
  );
}

/** Threshold above which the cost indicator renders in warning color. */
export const COST_WARNING_THRESHOLD = 0.8;

/** Returns true when cost ratio exceeds the warning threshold. */
export function isCostWarning(premiumRequests: number, estimatedTotal: number): boolean {
  if (estimatedTotal <= 0) return false;
  const ratio = premiumRequests / estimatedTotal;
  return Number.isFinite(ratio) && ratio > COST_WARNING_THRESHOLD;
}

function CostIndicator({
  state,
  quiet,
}: {
  readonly state: DebateState;
  readonly quiet: boolean;
}): ReactElement | null {
  if (quiet) return null;
  if (!state.cost) return null;
  const isWarning = isCostWarning(state.cost.premiumRequests, state.cost.estimatedTotal);
  return (
    <Box marginTop={1}>
      {isWarning ? (
        <Text color="yellow">
          {`[Cost: ${state.cost.premiumRequests}/${state.cost.estimatedTotal} premium requests]`}
        </Text>
      ) : (
        <Text dimColor>
          {`[Cost: ${state.cost.premiumRequests}/${state.cost.estimatedTotal} premium requests]`}
        </Text>
      )}
    </Box>
  );
}

function ErrorsView({ state }: { readonly state: DebateState }): ReactElement | null {
  if (state.errors.length === 0) return null;
  const MAX_DISPLAYED = 3;
  const hidden = Math.max(0, state.errors.length - MAX_DISPLAYED);
  const visible = state.errors.slice(-MAX_DISPLAYED);
  return (
    <Box flexDirection="column" marginTop={1}>
      {hidden > 0 && <Text dimColor>{`(${hidden} previous hidden)`}</Text>}
      {visible.map((err, i) => (
        <Text key={`err-${i}`} color="red">
          {`[error${err.expertSlug ? ` from ${err.expertSlug}` : ""}]: ${err.message}`}
          {err.recoverable ? " (recoverable)" : ""}
        </Text>
      ))}
    </Box>
  );
}

function CompletionMessage({ state }: { readonly state: DebateState }): ReactElement | null {
  if (state.endReason === null && !state.userCancelled) return null;
  const sym = getSymbols();
  const reason = state.userCancelled ? "cancelled" : state.endReason;
  return (
    <Box marginTop={1}>
      <Text bold color="green">{`${sym.complete} Debate complete (${reason})`}</Text>
    </Box>
  );
}

function LoadingIndicator({ state }: { readonly state: DebateState }): ReactElement | null {
  if (state.currentRound === null || state.activeTurn !== null) return null;
  // Only show if no turns have been completed in this round
  const hasCompletedTurnThisRound = state.completedItems.some(
    (item) => item.type === "turn" && item.round === state.currentRound,
  );
  if (hasCompletedTurnThisRound) return null;
  return (
    <Box marginTop={1}>
      <Text color="yellow">
        <Spinner type="dots" />
      </Text>
      <Text>{" Waiting for responses..."}</Text>
    </Box>
  );
}

export interface DebateAppProps {
  readonly events: AsyncIterable<DebateEvent>;
  readonly onComplete?: (err?: unknown) => void;
  /**
   * When true, suppress informational output such as the cost indicator.
   * Mirrors `PlainRendererOptions.quiet`. Defaults to false.
   */
  readonly quiet?: boolean;
  readonly showCost?: boolean;
}

export function DebateApp({
  events,
  onComplete,
  quiet = false,
  showCost = true,
}: DebateAppProps): ReactElement {
  const [state, setState] = useState<DebateState>({ ...INITIAL_STATE, showCost });
  const [iteratorRef] = useState<{ current: AsyncIterator<DebateEvent> | null }>({ current: null });

  const { isRawModeSupported } = useStdin();

  const handleCancel = (): void => {
    setState((prev) => ({ ...prev, userCancelled: true }));
    // Propagate cancellation to the upstream stream (best-effort)
    void iteratorRef.current?.return?.(undefined)?.catch(() => {
      // Swallow rejection — cancellation is best-effort
    });
    onComplete?.();
  };

  useEffect(() => {
    let cancelled = false;
    const iterator = events[Symbol.asyncIterator]();
    iteratorRef.current = iterator;
    void (async () => {
      let streamError: unknown;
      try {
        for await (const ev of { [Symbol.asyncIterator]: () => iterator }) {
          if (cancelled) break;
          setState((prev) => reduce(prev, ev));
        }
      } catch (err) {
        streamError = err;
        const message = err instanceof Error ? err.message : String(err);
        setState((prev) => ({
          ...prev,
          errors: [...prev.errors, { message, recoverable: false }],
        }));
      } finally {
        if (!cancelled) onComplete?.(streamError);
      }
    })();
    return () => {
      cancelled = true;
      iteratorRef.current = null;
    };
  }, [events, onComplete, iteratorRef]);

  return (
    <Box flexDirection="column">
      {isRawModeSupported && !state.userCancelled && <CtrlCHandler onCancel={handleCancel} />}
      <PanelRoster state={state} />
      <Static items={state.completedItems as StaticItem[]}>
        {(item) => <StaticItemView key={item.id} item={item} state={state} />}
      </Static>
      <ActiveTurnView state={state} />
      <LoadingIndicator state={state} />
      <RetryIndicator state={state} />
      <CostIndicator state={state} quiet={quiet} />
      <ErrorsView state={state} />
      <CompletionMessage state={state} />
    </Box>
  );
}

export interface InkRendererOptions {
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  /** Whether to show the running cost counter. Defaults to true. */
  readonly showCost?: boolean;
  /**
   * Hint used for diagnostics; does not change behavior. The selector
   * (`select.ts`) only constructs an `InkRenderer` when the output is
   * a TTY, so this is informational only.
   */
  readonly isTTY?: boolean;
  /**
   * When true, suppress informational output such as the cost indicator.
   * Mirrors `PlainRendererOptions.quiet`. Defaults to false.
   */
  readonly quiet?: boolean;
}

/** Sentinel error class to distinguish Ink initialization failures from stream errors. */
class InkRenderError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super("Ink render initialization failed");
    this.cause = cause;
  }
}

export class InkRenderer implements Renderer {
  readonly #stdout: NodeJS.WriteStream;
  readonly #stderr: NodeJS.WriteStream;
  readonly #quiet: boolean;
  readonly #showCost: boolean;

  constructor(opts: InkRendererOptions = {}) {
    this.#stdout = opts.stdout ?? process.stdout;
    this.#stderr = opts.stderr ?? process.stderr;
    this.#quiet = opts.quiet ?? false;
    this.#showCost = opts.showCost ?? true;
  }

  async render(events: AsyncIterable<DebateEvent>): Promise<void> {
    try {
      await this.#renderWithInk(events);
    } catch (err: unknown) {
      // A11Y-14: If Ink itself failed to initialize (ConPTY, MinTTY, etc.),
      // fall back to PlainRenderer. Stream errors are re-thrown as-is.
      if (err instanceof InkRenderError) {
        const message = err.cause instanceof Error ? err.cause.message : String(err.cause);
        this.#stderr.write(`[WARN] Ink renderer failed (${message}), falling back to plain text\n`);
        const sink: Sink = {
          write: (text: string) => this.#stdout.write(text),
          writeError: (text: string) => this.#stderr.write(text),
        };
        const plain = new PlainRenderer(sink, {
          color: false,
          quiet: this.#quiet,
          showCost: this.#showCost,
        });
        await plain.render(events);
      } else {
        throw err;
      }
    }
  }

  #renderWithInk(events: AsyncIterable<DebateEvent>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let done = false;
      let instance: ReturnType<typeof inkRender>;
      const finish = (err?: unknown): void => {
        if (done) return;
        done = true;
        try {
          instance.unmount();
        } catch {
          // best-effort
        }
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve();
      };
      try {
        instance = inkRender(
          <DebateApp
            events={events}
            onComplete={(err) => finish(err)}
            quiet={this.#quiet}
            showCost={this.#showCost}
          />,
          {
            stdout: this.#stdout,
            stderr: this.#stderr,
            exitOnCtrlC: false,
            patchConsole: false,
          },
        );
      } catch (initErr: unknown) {
        reject(new InkRenderError(initErr));
        return;
      }
      instance.waitUntilExit().then(
        () => finish(),
        (err: unknown) => finish(err),
      );
    });
  }
}
