import React from "react";
import { Box, Text } from "ink";
import { useNavigate } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import {
  sessionStatusSymbol,
  type SessionListItem,
  type SessionsDataSource,
} from "../adapters/sessions-data.js";
import { useData } from "../components/DataProvider.js";
import { ListViewport, type ListViewportItem } from "../components/lists/ListViewport.js";
import { useAsyncResource } from "../hooks/use-async-resource.js";
import { type ResizableStdout } from "../hooks/use-terminal-size.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface SessionsScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
  readonly stdout?: ResizableStdout | undefined;
}

const EMPTY_LIST: () => Promise<readonly SessionListItem[]> = async () => [];

export function SessionsScreen(props: SessionsScreenProps): React.ReactElement {
  const data = useData();
  const sessions = data.sessions as SessionsDataSource | undefined;
  const loadList = sessions?.loadList ?? EMPTY_LIST;
  const state = useAsyncResource(loadList);
  const navigate = useNavigate();

  if (state.status === "loading") {
    return <Text>{props.theme.muted("Loading sessions…")}</Text>;
  }

  if (state.status === "error") {
    return <Text>{props.theme.error("Failed to load sessions")}</Text>;
  }

  const items: readonly ListViewportItem[] = state.data.map((session) => ({
    id: session.panelId,
    label: toSingleLineDisplay(
      `${sessionStatusSymbol(session.latestStatus)} ${session.panelName}  ${String(
        session.debateCount,
      )} debates · ${String(session.turnCount)} turns${
        session.topic === "" ? "" : `  ${session.topic}`
      }`,
    ),
  }));

  const sessionData = state.data;

  return (
    <ListViewport
      items={items}
      isActive={props.isActive ?? false}
      onSelect={(id) => {
        const session = sessionData.find((s) => s.panelId === id);
        if (session !== undefined) {
          navigate(`/sessions/${encodeURIComponent(session.panelId)}`, {
            state: { panelName: session.panelName },
          });
        }
      }}
      theme={props.theme}
      title="Sessions"
      emptyText={props.theme.accent("No debates yet — convene a panel to watch them deliberate")}
      stdout={props.stdout}
      renderPreview={(id) => {
        const session = sessionData.find((s) => s.panelId === id);
        if (session === undefined) return null;
        return (
          <Box flexDirection="column">
            <Text bold>
              {sessionStatusSymbol(session.latestStatus)} {toSingleLineDisplay(session.panelName)}
            </Text>
            <Text>
              {String(session.debateCount)} debates · {String(session.turnCount)} turns
            </Text>
            {session.topic !== "" && <Text>{toSingleLineDisplay(session.topic)}</Text>}
          </Box>
        );
      }}
    />
  );
}
