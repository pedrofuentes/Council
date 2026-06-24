import React from "react";
import { Box, Text, useInput } from "ink";
import { useLocation, useNavigate, useParams } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { ConveneDataSource, ConveneViewEvent } from "../adapters/convene.js";
import { useData } from "../components/DataProvider.js";
import { useInputCapture } from "../components/InputCaptureProvider.js";
import { ScrollView } from "../components/lists/ScrollView.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface DebateStreamScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

interface TurnView {
  readonly expert: string;
  readonly round: number;
  readonly body: string;
  readonly done: boolean;
}

interface DebateView {
  readonly experts: readonly string[];
  readonly turns: readonly TurnView[];
  readonly cost: { readonly premiumRequests: number; readonly estimatedTotal: number } | undefined;
  readonly error: string | undefined;
}

type RunStatus = "streaming" | "done" | "unavailable";

const EMPTY_VIEW: DebateView = { experts: [], turns: [], cost: undefined, error: undefined };

function errorMessage(err: unknown): string {
  return toSingleLineDisplay(err instanceof Error ? err.message : String(err));
}

function applyEvent(view: DebateView, event: ConveneViewEvent): DebateView {
  switch (event.kind) {
    case "panel":
      return { ...view, experts: event.experts };
    case "round":
      return view;
    case "turn-start":
      return {
        ...view,
        turns: [...view.turns, { expert: event.expert, round: event.round, body: "", done: false }],
      };
    case "turn-delta": {
      const turns = view.turns.slice();
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        const turn = turns[i];
        if (turn !== undefined && !turn.done && turn.expert === event.expert) {
          turns[i] = { ...turn, body: turn.body + event.text };
          return { ...view, turns };
        }
      }
      return view;
    }
    case "turn-end": {
      const turns = view.turns.slice();
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        const turn = turns[i];
        if (turn !== undefined && !turn.done && turn.expert === event.expert) {
          turns[i] = { ...turn, done: true };
          return { ...view, turns };
        }
      }
      return view;
    }
    case "cost":
      return {
        ...view,
        cost: { premiumRequests: event.premiumRequests, estimatedTotal: event.estimatedTotal },
      };
    case "error":
      return { ...view, error: event.message };
    case "end":
      return view;
  }
}

function transcriptLines(view: DebateView): readonly string[] {
  const lines: string[] = [];
  let lastRound: number | undefined;
  for (const turn of view.turns) {
    if (turn.round !== lastRound) {
      lines.push(toSingleLineDisplay(`── Round ${String(turn.round)} ──`));
      lastRound = turn.round;
    }
    lines.push(toSingleLineDisplay(`${turn.expert}:`));
    // Untrusted streamed body: toSingleLineDisplay strips control chars AND
    // collapses CR/LF/U+2028/U+2029 runs, so a turn cannot CR-overwrite a row
    // or forge a new transcript line. Each turn body renders as one row.
    const body = toSingleLineDisplay(turn.body);
    if (body.length > 0) {
      lines.push(`  ${body}`);
    }
  }
  return lines;
}

function activeExpert(view: DebateView): string | undefined {
  for (let i = view.turns.length - 1; i >= 0; i -= 1) {
    const turn = view.turns[i];
    if (turn !== undefined && !turn.done) {
      return turn.expert;
    }
  }
  return undefined;
}

export function DebateStreamScreen(props: DebateStreamScreenProps): React.ReactElement {
  const { panel } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const data = useData();
  const convene = data.convene as ConveneDataSource | undefined;
  const { setCaptured } = useInputCapture();

  const topic = (location.state as { readonly topic?: string } | null)?.topic;
  const panelName = toSingleLineDisplay(panel ?? "");

  const [view, setView] = React.useState<DebateView>(EMPTY_VIEW);
  const [status, setStatus] = React.useState<RunStatus>("streaming");

  const controllerRef = React.useRef<AbortController | null>(null);
  const startedRef = React.useRef(false);
  const unmountedRef = React.useRef(false);

  React.useEffect(() => {
    setCaptured(true);
    return () => {
      setCaptured(false);
    };
  }, [setCaptured]);

  React.useEffect(() => {
    if (startedRef.current) return;
    if (convene === undefined || panel === undefined || topic === undefined || topic.length === 0) {
      setStatus("unavailable");
      return;
    }

    startedRef.current = true;
    unmountedRef.current = false;
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus("streaming");

    const applyIfMounted = (event: ConveneViewEvent): void => {
      if (unmountedRef.current) return;
      setView((current) => applyEvent(current, event));
    };

    void (async (): Promise<void> => {
      try {
        const result = await convene.streamDebate(
          panel,
          topic,
          { signal: controller.signal },
          applyIfMounted,
        );
        if (unmountedRef.current) return;
        setStatus("done");
        if (result.debateId !== undefined) {
          navigate(`/sessions/${encodeURIComponent(result.debateId)}`, {
            state: { panelName: panel },
          });
        } else {
          navigate(-1);
        }
      } catch (err) {
        if (unmountedRef.current) return;
        setView((current) => ({ ...current, error: errorMessage(err) }));
        setStatus("done");
      }
    })();

    return () => {
      unmountedRef.current = true;
      controller.abort();
    };
  }, [convene, navigate, panel, topic]);

  useInput(
    (_input, key) => {
      if (!key.escape) return;
      if (status === "streaming") {
        controllerRef.current?.abort();
        return;
      }
      navigate(-1);
    },
    { isActive: props.isActive ?? false },
  );

  if (status === "unavailable") {
    return (
      <Box flexDirection="column">
        <Text>{props.theme.error(toSingleLineDisplay("convene unavailable"))}</Text>
        <Text>{props.theme.muted(toSingleLineDisplay("Esc back"))}</Text>
      </Box>
    );
  }

  const lines = transcriptLines(view);
  const responder = activeExpert(view);

  return (
    <Box flexDirection="column">
      <Text>{props.theme.accent(toSingleLineDisplay(`Convene ${panelName}`))}</Text>
      {topic !== undefined && topic.length > 0 ? (
        <Text>{props.theme.muted(toSingleLineDisplay(`Topic: ${topic}`))}</Text>
      ) : null}
      {view.experts.length > 0 ? (
        <Text>{toSingleLineDisplay(`Experts: ${view.experts.join(", ")}`)}</Text>
      ) : null}
      {lines.length > 0 ? <ScrollView items={lines} height={12} follow /> : null}
      {status === "streaming" ? (
        <Text>
          {props.theme.muted(
            toSingleLineDisplay(
              responder !== undefined ? `${responder} is responding…` : "Convening…",
            ),
          )}
        </Text>
      ) : null}
      {view.cost !== undefined ? (
        <Text>
          {props.theme.muted(
            toSingleLineDisplay(
              `Cost: ${String(view.cost.premiumRequests)} premium req · ~${String(
                view.cost.estimatedTotal,
              )} total`,
            ),
          )}
        </Text>
      ) : null}
      {view.error !== undefined ? (
        <Text>{props.theme.error(toSingleLineDisplay(`Error: ${view.error}`))}</Text>
      ) : null}
      <Text>
        {props.theme.muted(toSingleLineDisplay(status === "streaming" ? "Esc cancel" : "Esc back"))}
      </Text>
    </Box>
  );
}
