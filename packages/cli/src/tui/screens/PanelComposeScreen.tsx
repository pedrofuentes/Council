import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useNavigate } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { PanelComposeDataSource, PanelComposePreview } from "../adapters/panel-compose.js";
import { useData } from "../components/DataProvider.js";
import { useInputCapture } from "../components/InputCaptureProvider.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface PanelComposeScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

type ComposeState =
  | { readonly status: "idle" }
  | { readonly status: "composing" }
  | { readonly status: "preview"; readonly preview: PanelComposePreview }
  | { readonly status: "persisting"; readonly preview: PanelComposePreview }
  | { readonly status: "error"; readonly message: string };

function errorMessage(err: unknown): string {
  return toSingleLineDisplay(err instanceof Error ? err.message : String(err));
}

export function PanelComposeScreen(props: PanelComposeScreenProps): React.ReactElement {
  const data = useData();
  const panelCompose = data.panelCompose as PanelComposeDataSource | undefined;
  const navigate = useNavigate();
  const { setCaptured } = useInputCapture();
  const [topic, setTopic] = React.useState("");
  const topicRef = React.useRef("");
  const [state, setState] = React.useState<ComposeState>({ status: "idle" });
  const inFlight = React.useRef(false);
  const isActive = props.isActive ?? true;

  React.useEffect(() => {
    setCaptured(true);
    return () => {
      setCaptured(false);
    };
  }, [setCaptured]);

  const submitTopic = React.useCallback(async (): Promise<void> => {
    const trimmed = topicRef.current.trim();
    if (trimmed.length === 0 || inFlight.current) return;
    if (panelCompose === undefined) {
      setState({ status: "error", message: toSingleLineDisplay("Panel auto-compose unavailable") });
      return;
    }
    inFlight.current = true;
    setState({ status: "composing" });
    try {
      const preview = await panelCompose.compose(trimmed);
      setState({ status: "preview", preview });
    } catch (err) {
      setState({ status: "error", message: errorMessage(err) });
    } finally {
      inFlight.current = false;
    }
  }, [panelCompose]);

  const confirmPreview = React.useCallback(async (): Promise<void> => {
    if (state.status !== "preview" || inFlight.current) return;
    if (panelCompose === undefined) {
      setState({ status: "error", message: toSingleLineDisplay("Panel auto-compose unavailable") });
      return;
    }
    const preview = state.preview;
    const submittedTopic = topicRef.current;
    inFlight.current = true;
    setState({ status: "persisting", preview });
    try {
      const result = await panelCompose.persist(preview.definition);
      navigate(`/convene/${encodeURIComponent(result.panelName)}/run`, {
        state: { topic: submittedTopic, panelName: result.panelName },
      });
    } catch (err) {
      setState({ status: "error", message: errorMessage(err) });
    } finally {
      inFlight.current = false;
    }
  }, [navigate, panelCompose, state, topicRef]);

  const resetToIdle = React.useCallback((): void => {
    if (inFlight.current) return;
    setState({ status: "idle" });
  }, []);

  useInput(
    (input, key) => {
      if (key.escape) {
        if (!inFlight.current) navigate(-1);
        return;
      }
      if ((state.status === "idle" || state.status === "error") && key.return) {
        void submitTopic();
        return;
      }
      if (state.status === "preview") {
        if (input === "y") {
          void confirmPreview();
          return;
        }
        if (input === "n" || input === "e") {
          resetToIdle();
        }
      }
    },
    { isActive },
  );

  if (panelCompose === undefined) {
    return <Text>{props.theme.error(toSingleLineDisplay("Panel auto-compose unavailable"))}</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text>{props.theme.accent(toSingleLineDisplay("Auto-compose panel"))}</Text>
      {state.status === "idle" || state.status === "error" ? (
        <Box>
          <Text>{toSingleLineDisplay("Topic: ")}</Text>
          <TextInput
            focus={isActive && !inFlight.current}
            onChange={(value) => {
              topicRef.current = value;
              setTopic(value);
              if (state.status === "error") setState({ status: "idle" });
            }}
            onSubmit={() => {
              void submitTopic();
            }}
            showCursor={isActive && !inFlight.current}
            value={toSingleLineDisplay(topic)}
          />
        </Box>
      ) : null}
      {state.status === "composing" ? (
        <Text>{props.theme.muted(toSingleLineDisplay("Composing panel…"))}</Text>
      ) : null}
      {state.status === "preview" || state.status === "persisting" ? (
        <Box flexDirection="column">
          <Text>{props.theme.accent(toSingleLineDisplay(state.preview.name))}</Text>
          {state.preview.description !== null ? (
            <Text>{toSingleLineDisplay(state.preview.description)}</Text>
          ) : null}
          {state.preview.experts.map((expert) => (
            <Text key={`${expert.displayName}:${expert.role}`}>
              {toSingleLineDisplay(`• ${expert.displayName} — ${expert.role}`)}
            </Text>
          ))}
          <Text>
            {props.theme.muted(
              toSingleLineDisplay(
                state.status === "persisting" ? "Saving panel…" : "y Save & convene · n/e edit · Esc cancel",
              ),
            )}
          </Text>
        </Box>
      ) : null}
      {state.status === "error" ? <Text>{props.theme.error(state.message)}</Text> : null}
    </Box>
  );
}
