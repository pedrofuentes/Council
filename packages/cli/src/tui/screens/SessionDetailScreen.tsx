import React from "react";
import { Box, Text } from "ink";
import { useLocation } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type {
  SessionsDataSource,
  SessionTranscriptView,
  TranscriptLine,
} from "../adapters/sessions-data.js";
import { useData } from "../components/DataProvider.js";
import { ScrollView } from "../components/lists/ScrollView.js";
import { useAsyncResource } from "../hooks/use-async-resource.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface SessionDetailScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

function formatLine(line: TranscriptLine): string {
  const speaker = toSingleLineDisplay(line.speaker);
  const content = toSingleLineDisplay(line.content);
  return toSingleLineDisplay(`[r${String(line.round)}] ${speaker}: ${content}`);
}

function renderDetail(detail: SessionTranscriptView, theme: SemanticTheme): React.ReactElement {
  const rows = detail.lines.map(formatLine);

  return (
    <Box flexDirection="column">
      <Text>{theme.accent(toSingleLineDisplay(detail.panelName))}</Text>
      {detail.topic !== "" ? <Text>{toSingleLineDisplay(detail.topic)}</Text> : undefined}
      <Text>{theme.muted(toSingleLineDisplay(`Prompt: ${detail.prompt}`))}</Text>
      <Text>{theme.muted(toSingleLineDisplay(`Status: ${detail.status}`))}</Text>
      {rows.length === 0 ? (
        <Text>{theme.muted("No turns yet")}</Text>
      ) : (
        <ScrollView items={rows} height={12} />
      )}
    </Box>
  );
}

export function SessionDetailScreen(props: SessionDetailScreenProps): React.ReactElement {
  const location = useLocation();
  const panelName = (location.state as { panelName?: string } | null)?.panelName;
  const data = useData();
  const sessions = data.sessions as SessionsDataSource | undefined;
  const loader = React.useCallback(
    () =>
      sessions !== undefined && panelName !== undefined
        ? sessions.loadTranscript(panelName)
        : Promise.resolve<SessionTranscriptView | undefined>(undefined),
    [sessions, panelName],
  );
  const state = useAsyncResource(loader);

  if (state.status === "loading") {
    return <Text>{props.theme.muted("Loading session…")}</Text>;
  }

  if (state.status === "error") {
    return <Text>{props.theme.error("Failed to load session")}</Text>;
  }

  if (state.data === undefined) {
    return <Text>{props.theme.warn("Session not found")}</Text>;
  }

  return renderDetail(state.data, props.theme);
}
