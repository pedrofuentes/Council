import React from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate, useParams } from "react-router";

import { stripControlChars, toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { ConveneDataSource, CostEstimate } from "../adapters/convene.js";
import { CostConfirmModal } from "../components/CostConfirmModal.js";
import { useData } from "../components/DataProvider.js";
import { MultilineInput } from "../components/inputs/MultilineInput.js";
import { useInputCapture } from "../components/InputCaptureProvider.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface ConvenePromptScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

type PromptState =
  | { readonly status: "idle" }
  | { readonly status: "estimating" }
  | { readonly status: "confirm"; readonly estimate: CostEstimate }
  | { readonly status: "error"; readonly message: string };

function errorMessage(err: unknown): string {
  return toSingleLineDisplay(err instanceof Error ? err.message : String(err));
}

// Sanitize a user-entered topic while PRESERVING intended newlines: strip
// terminal control/escape sequences, normalize CR/LF to plain "\n", and trim.
// Parity with the classic-CLI topic editor (interactive-topic-input.ts).
function normalizeTopic(text: string): string {
  return stripControlChars(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

export function ConvenePromptScreen(props: ConvenePromptScreenProps): React.ReactElement {
  const { panel } = useParams();
  const navigate = useNavigate();
  const data = useData();
  const convene = data.convene as ConveneDataSource | undefined;
  const { setCaptured } = useInputCapture();
  const [topic, setTopic] = React.useState("");
  const topicRef = React.useRef("");
  const [state, setState] = React.useState<PromptState>({ status: "idle" });
  const inFlight = React.useRef(false);
  // Tracks the current cost estimate by controller identity so a slow/hung
  // estimate can be cancelled (Esc / unmount) without its late resolution
  // overwriting state that belongs to a newer estimate or a gone screen (#1676).
  const estimateController = React.useRef<AbortController | null>(null);
  const unmounted = React.useRef(false);
  const isActive = props.isActive ?? true;
  const panelName = toSingleLineDisplay(panel ?? "");

  React.useEffect(() => {
    setCaptured(true);
    return () => {
      setCaptured(false);
    };
  }, [setCaptured]);

  React.useEffect(() => {
    return () => {
      // On unmount, mark the screen gone and abort any in-flight estimate so a
      // late-resolving estimate cannot update state after teardown (#1676).
      unmounted.current = true;
      estimateController.current?.abort();
    };
  }, []);

  const submitTopic = React.useCallback(async (): Promise<void> => {
    const trimmed = normalizeTopic(topicRef.current);
    if (trimmed.length === 0 || inFlight.current) return;
    if (convene === undefined || panel === undefined) {
      setState({ status: "error", message: toSingleLineDisplay("convene unavailable") });
      return;
    }

    inFlight.current = true;
    setState({ status: "estimating" });
    // Supersede any prior estimate and track this one by controller identity.
    estimateController.current?.abort();
    const controller = new AbortController();
    estimateController.current = controller;
    try {
      const estimate = await convene.estimateCost(panel);
      // Late-resolution guard: drop the result if this estimate was cancelled
      // (Esc/supersede) or the screen unmounted while it was in flight.
      if (controller.signal.aborted || unmounted.current) return;
      setState({ status: "confirm", estimate });
    } catch (err) {
      if (controller.signal.aborted || unmounted.current) return;
      setState({ status: "error", message: errorMessage(err) });
    } finally {
      // Only the current estimate owns inFlight; a superseding estimate has
      // already taken over, so it must not clear the newer estimate's guard.
      if (estimateController.current === controller) {
        inFlight.current = false;
      }
    }
  }, [convene, panel]);

  const cancel = React.useCallback((): void => {
    if (inFlight.current) return;
    navigate(-1);
  }, [navigate]);

  const confirm = React.useCallback((): void => {
    if (state.status !== "confirm" || inFlight.current || panel === undefined) return;
    const trimmed = normalizeTopic(topicRef.current);
    if (trimmed.length === 0) return;
    inFlight.current = true;
    navigate(`/convene/${encodeURIComponent(panel)}/run`, { state: { topic: trimmed } });
  }, [navigate, panel, state.status]);

  useInput(
    (_input, key) => {
      if (key.escape) {
        if (state.status === "estimating") {
          // Cancel a slow/hung estimate so it can't wedge the TUI (#1676) and
          // return to the topic editor; the late-resolution guard then drops the
          // cancelled estimate's result. A second Esc (now idle) leaves.
          estimateController.current?.abort();
          inFlight.current = false;
          setState({ status: "idle" });
          return;
        }
        if (!inFlight.current) navigate(-1);
        return;
      }
    },
    { isActive },
  );

  if (convene === undefined || panel === undefined) {
    return <Text>{props.theme.error(toSingleLineDisplay("convene unavailable"))}</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text>{props.theme.accent(toSingleLineDisplay(`Convene ${panelName}`))}</Text>
      {state.status === "idle" || state.status === "error" ? (
        <Box>
          <Text>{toSingleLineDisplay("Topic: ")}</Text>
          <MultilineInput
            isActive={isActive && !inFlight.current}
            onChange={(value) => {
              topicRef.current = value;
              setTopic(value);
              if (state.status === "error") setState({ status: "idle" });
            }}
            onSubmit={() => {
              void submitTopic();
            }}
            value={topic}
          />
        </Box>
      ) : null}
      {state.status === "estimating" ? (
        <Text>{props.theme.muted(toSingleLineDisplay("Estimating debate cost…"))}</Text>
      ) : null}
      {state.status === "confirm" ? (
        <CostConfirmModal
          theme={props.theme}
          experts={state.estimate.experts}
          rounds={state.estimate.rounds}
          estimatedPremiumRequests={state.estimate.estimatedPremiumRequests}
          onConfirm={confirm}
          onCancel={cancel}
          isActive={isActive && !inFlight.current}
        />
      ) : null}
      {state.status === "error" ? <Text>{props.theme.error(state.message)}</Text> : null}
      <Text>
        {props.theme.muted(toSingleLineDisplay("Enter estimate · Ctrl+J newline · Esc cancel"))}
      </Text>
    </Box>
  );
}
