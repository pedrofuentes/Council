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
 * `InkRenderer` is the `Renderer` adapter the CLI uses — it mounts
 * `DebateApp` via `ink.render()` and resolves when the stream ends.
 *
 * Selection between Ink, Plain, and JSON renderers lives in
 * `../select.ts` (Ink is auto-selected on TTY when the user does not
 * pass `--format`).
 */
import { useEffect, useState, type ReactElement } from "react";
import { Box, Text, render as inkRender } from "ink";
import Spinner from "ink-spinner";

import type { DebateEndReason, DebateEvent, PanelMemberSnapshot } from "../../../core/types.js";
import type { Renderer } from "../types.js";

import { assignExpertColor, formatExpertPrefix, type ExpertColor } from "./colors.js";

interface TurnBlock {
  readonly round: number;
  readonly expertSlug: string;
  text: string;
  ended: boolean;
}

interface DebateState {
  readonly panel: readonly PanelMemberSnapshot[];
  readonly expertIndex: ReadonlyMap<string, number>;
  readonly humanSlugs: ReadonlySet<string>;
  readonly displayNames: ReadonlyMap<string, string>;
  readonly currentRound: number | null;
  readonly turns: readonly TurnBlock[];
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
}

const INITIAL_STATE: DebateState = {
  panel: [],
  expertIndex: new Map(),
  humanSlugs: new Set(),
  displayNames: new Map(),
  currentRound: null,
  turns: [],
  cost: null,
  errors: [],
  retrying: null,
  endReason: null,
};

function reduce(s: DebateState, ev: DebateEvent): DebateState {
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
    case "round.start":
      return { ...s, currentRound: ev.round, retrying: null };
    case "turn.start":
      return {
        ...s,
        turns: [...s.turns, { round: ev.round, expertSlug: ev.expertSlug, text: "", ended: false }],
        retrying: null,
      };
    case "turn.delta": {
      const turns = s.turns.slice();
      const last = turns[turns.length - 1];
      if (last && last.expertSlug === ev.expertSlug && !last.ended) {
        turns[turns.length - 1] = { ...last, text: last.text + ev.text };
      } else {
        turns.push({
          round: s.currentRound ?? 0,
          expertSlug: ev.expertSlug,
          text: ev.text,
          ended: false,
        });
      }
      return { ...s, turns };
    }
    case "turn.end": {
      const turns = s.turns.slice();
      let idx = -1;
      for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i];
        if (t && t.expertSlug === ev.expertSlug && !t.ended) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) {
        const existing = turns[idx];
        if (existing) {
          turns[idx] = {
            ...existing,
            text: existing.text.length > 0 ? existing.text : ev.content,
            ended: true,
          };
        }
      } else {
        turns.push({
          round: s.currentRound ?? 0,
          expertSlug: ev.expertSlug,
          text: ev.content,
          ended: true,
        });
      }
      return { ...s, turns };
    }
    case "round.end":
      return s;
    case "cost.update":
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
        retrying: {
          expertSlug: ev.expertSlug,
          attempt: ev.attempt,
          reason: ev.reason,
        },
      };
  }
}

function colorFor(state: DebateState, slug: string): ExpertColor {
  return assignExpertColor(state.expertIndex.get(slug) ?? 0);
}

function nameFor(state: DebateState, slug: string): string {
  return state.displayNames.get(slug) ?? slug;
}

function PanelRoster({ state }: { readonly state: DebateState }): ReactElement | null {
  if (state.panel.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>🏛️ Panel assembled</Text>
      {state.panel.map((expert) => {
        const color = colorFor(state, expert.slug);
        const idx = state.expertIndex.get(expert.slug) ?? 0;
        const isHuman = expert.participantKind === "human" || state.humanSlugs.has(expert.slug);
        return (
          <Text key={expert.slug}>
            {"  • "}
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
  return (
    <Box marginTop={1}>
      <Text bold>{`━━━ Round ${round + 1} ━━━`}</Text>
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
}: {
  readonly text: string;
  readonly ended: boolean;
}): ReactElement {
  return (
    <Text>
      {text}
      {!ended && text.length > 0 ? <Text color="cyan">{" ▋"}</Text> : null}
    </Text>
  );
}

function TurnsView({ state }: { readonly state: DebateState }): ReactElement | null {
  if (state.turns.length === 0) return null;
  // Group turns by round so we can render round headers between them.
  const items: ReactElement[] = [];
  let lastRound: number | null = null;
  state.turns.forEach((turn, i) => {
    if (turn.round !== lastRound) {
      items.push(<RoundHeader key={`round-${turn.round}-${i}`} round={turn.round} />);
      lastRound = turn.round;
    }
    items.push(
      <Box key={`turn-${i}`} flexDirection="column" marginTop={1}>
        <ExpertCard state={state} slug={turn.expertSlug} />
        <StreamingText text={turn.text} ended={turn.ended} />
      </Box>,
    );
  });
  return <Box flexDirection="column">{items}</Box>;
}

function StandaloneRoundHeader({ state }: { readonly state: DebateState }): ReactElement | null {
  // When round.start has fired but no turn has started yet, we still want
  // to show the round header so the user sees progress.
  if (state.currentRound === null) return null;
  if (state.turns.some((t) => t.round === state.currentRound)) return null;
  return <RoundHeader round={state.currentRound} />;
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

function CostIndicator({ state }: { readonly state: DebateState }): ReactElement | null {
  if (!state.cost) return null;
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {`[Cost: ${state.cost.premiumRequests}/${state.cost.estimatedTotal} premium requests]`}
      </Text>
    </Box>
  );
}

function ErrorsView({ state }: { readonly state: DebateState }): ReactElement | null {
  if (state.errors.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {state.errors.map((err, i) => (
        <Text key={`err-${i}`} color="red">
          {`[error${err.expertSlug ? ` from ${err.expertSlug}` : ""}]: ${err.message}`}
          {err.recoverable ? " (recoverable)" : ""}
        </Text>
      ))}
    </Box>
  );
}

function CompletionMessage({ state }: { readonly state: DebateState }): ReactElement | null {
  if (state.endReason === null) return null;
  return (
    <Box marginTop={1}>
      <Text bold>{`--- Debate complete (${state.endReason}) ---`}</Text>
    </Box>
  );
}

export interface DebateAppProps {
  readonly events: AsyncIterable<DebateEvent>;
  readonly onComplete?: (err?: unknown) => void;
}

export function DebateApp({ events, onComplete }: DebateAppProps): ReactElement {
  const [state, setState] = useState<DebateState>(INITIAL_STATE);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let streamError: unknown;
      try {
        for await (const ev of events) {
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
    };
  }, [events, onComplete]);

  return (
    <Box flexDirection="column">
      <PanelRoster state={state} />
      <StandaloneRoundHeader state={state} />
      <TurnsView state={state} />
      <RetryIndicator state={state} />
      <CostIndicator state={state} />
      <ErrorsView state={state} />
      <CompletionMessage state={state} />
    </Box>
  );
}

export interface InkRendererOptions {
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  /**
   * Hint used for diagnostics; does not change behavior. The selector
   * (`select.ts`) only constructs an `InkRenderer` when the output is
   * a TTY, so this is informational only.
   */
  readonly isTTY?: boolean;
}

export class InkRenderer implements Renderer {
  readonly #stdout: NodeJS.WriteStream;
  readonly #stderr: NodeJS.WriteStream;

  constructor(opts: InkRendererOptions = {}) {
    this.#stdout = opts.stdout ?? process.stdout;
    this.#stderr = opts.stderr ?? process.stderr;
  }

  async render(events: AsyncIterable<DebateEvent>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let done = false;
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
      const instance = inkRender(
        <DebateApp events={events} onComplete={(err) => finish(err)} />,
        {
          stdout: this.#stdout,
          stderr: this.#stderr,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      instance.waitUntilExit().then(
        () => finish(),
        (err: unknown) => finish(err),
      );
    });
  }
}
