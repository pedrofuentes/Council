import React from "react";
import { Box, Text, useInput } from "ink";
import { useLocation, useNavigate } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { ConcludeDataSource, ConclusionView } from "../adapters/conclude.js";
import { useData } from "../components/DataProvider.js";
import { useInputCapture } from "../components/InputCaptureProvider.js";
import { ScrollView } from "../components/lists/ScrollView.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface ConclusionScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

type RunStatus = "loading" | "ready" | "error" | "unavailable";

interface ConclusionScreenState {
  readonly status: RunStatus;
  readonly view: ConclusionView | null;
  readonly error: string | undefined;
}

const INITIAL_STATE: ConclusionScreenState = {
  status: "loading",
  view: null,
  error: undefined,
};

function errorMessage(err: unknown): string {
  return toSingleLineDisplay(err instanceof Error ? err.message : String(err));
}

/**
 * Flatten the conclusion into one sanitized line per row. Every string here is
 * model-generated (untrusted); `toSingleLineDisplay` strips control chars AND
 * collapses CR/LF/U+2028/U+2029 runs so a field cannot CR-overwrite a row or
 * forge a fake transcript line in the scroll sink.
 */
function bodyLines(view: ConclusionView): readonly string[] {
  const lines: string[] = [];

  if (view.consensus.length > 0) {
    lines.push(toSingleLineDisplay("Consensus:"));
    for (const item of view.consensus) {
      lines.push(toSingleLineDisplay(`  • ${item}`));
    }
  }

  if (view.tensions.length > 0) {
    lines.push(toSingleLineDisplay("Tensions:"));
    for (const item of view.tensions) {
      lines.push(toSingleLineDisplay(`  • ${item}`));
    }
  }

  if (view.decisionMatrix.length > 0) {
    lines.push(toSingleLineDisplay("Decision matrix:"));
    for (const dimension of view.decisionMatrix) {
      lines.push(toSingleLineDisplay(`  ${dimension.dimension}`));
      for (const stance of dimension.stances) {
        lines.push(toSingleLineDisplay(`    ${stance.expert}: ${stance.stance}`));
      }
    }
  }

  return lines;
}

export function ConclusionScreen(props: ConclusionScreenProps): React.ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const data = useData();
  const conclude = data.conclude as ConcludeDataSource | undefined;
  const { setCaptured } = useInputCapture();

  const panelName = (location.state as { readonly panelName?: string } | null)?.panelName;

  const [state, setState] = React.useState<ConclusionScreenState>(INITIAL_STATE);

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
    if (conclude === undefined || panelName === undefined || panelName.length === 0) {
      setState({ status: "unavailable", view: null, error: undefined });
      return;
    }

    startedRef.current = true;
    unmountedRef.current = false;
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ status: "loading", view: null, error: undefined });

    void (async (): Promise<void> => {
      try {
        const view = await conclude.synthesize(panelName, { signal: controller.signal });
        if (unmountedRef.current) return;
        setState({ status: "ready", view, error: undefined });
      } catch (err) {
        if (unmountedRef.current) return;
        // A cancel (unmount or Esc) aborts the controller; treat it as a back
        // navigation rather than an error surface.
        if (controller.signal.aborted) {
          navigate(-1);
          return;
        }
        setState({ status: "error", view: null, error: errorMessage(err) });
      }
    })();

    return () => {
      unmountedRef.current = true;
      // Reset so a dependency change re-runs synthesis instead of dead-ending in
      // a stuck "loading" state (#1677).
      startedRef.current = false;
      controller.abort();
    };
  }, [conclude, navigate, panelName]);

  useInput(
    (_input, key) => {
      if (!key.escape) return;
      if (state.status === "loading") {
        controllerRef.current?.abort();
        return;
      }
      navigate(-1);
    },
    { isActive: props.isActive ?? false },
  );

  if (state.status === "unavailable") {
    return (
      <Box flexDirection="column">
        <Text>{props.theme.error(toSingleLineDisplay("conclusion unavailable"))}</Text>
        <Text>{props.theme.muted(toSingleLineDisplay("Esc back"))}</Text>
      </Box>
    );
  }

  const header = (
    <Text>{props.theme.accent(toSingleLineDisplay(`Conclusion · ${panelName ?? ""}`))}</Text>
  );

  if (state.status === "loading") {
    return (
      <Box flexDirection="column">
        {header}
        <Text>{props.theme.muted(toSingleLineDisplay("Concluding…"))}</Text>
        <Text>{props.theme.muted(toSingleLineDisplay("Esc cancel"))}</Text>
      </Box>
    );
  }

  if (state.status === "error") {
    return (
      <Box flexDirection="column">
        {header}
        <Text>
          {props.theme.error(toSingleLineDisplay(`Error: ${state.error ?? "unknown error"}`))}
        </Text>
        <Text>{props.theme.muted(toSingleLineDisplay("Esc back"))}</Text>
      </Box>
    );
  }

  const view = state.view;
  if (view === null) {
    return (
      <Box flexDirection="column">
        {header}
        <Text>{props.theme.muted(toSingleLineDisplay("Esc back"))}</Text>
      </Box>
    );
  }

  const lines = bodyLines(view);

  return (
    <Box flexDirection="column">
      {header}
      {view.topic.length > 0 ? (
        <Text>{props.theme.muted(toSingleLineDisplay(`Topic: ${view.topic}`))}</Text>
      ) : null}
      {lines.length > 0 ? <ScrollView items={lines} height={14} /> : null}
      <Text>
        {props.theme.accent(toSingleLineDisplay(`Recommendation: ${view.recommendation}`))}
      </Text>
      <Text>{props.theme.muted(toSingleLineDisplay(`Confidence: ${view.confidence}`))}</Text>
      {view.warnings.map((warning, index) => (
        <Text key={index}>{props.theme.warn(toSingleLineDisplay(`⚠ ${warning}`))}</Text>
      ))}
      <Text>{props.theme.muted(toSingleLineDisplay("Esc back"))}</Text>
    </Box>
  );
}
