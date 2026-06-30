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
  const isActive = props.isActive ?? true;
  const panelName = toSingleLineDisplay(panel ?? "");

  React.useEffect(() => {
    setCaptured(true);
    return () => {
      setCaptured(false);
    };
  }, [setCaptured]);

  const submitTopic = React.useCallback(async (): Promise<void> => {
    const trimmed = normalizeTopic(topicRef.current);
    if (trimmed.length === 0 || inFlight.current) return;
    if (convene === undefined || panel === undefined) {
      setState({ status: "error", message: toSingleLineDisplay("convene unavailable") });
      return;
    }

    inFlight.current = true;
    setState({ status: "estimating" });
    try {
      const estimate = await convene.estimateCost(panel);
      setState({ status: "confirm", estimate });
    } catch (err) {
      setState({ status: "error", message: errorMessage(err) });
    } finally {
      inFlight.current = false;
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
