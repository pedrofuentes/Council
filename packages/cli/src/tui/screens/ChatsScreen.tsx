import React from "react";
import { Box, Text } from "ink";
import { useNavigate } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import {
  chatTargetSymbol,
  type ChatListItem,
  type ChatsDataSource,
} from "../adapters/chats-data.js";
import { useData } from "../components/DataProvider.js";
import { ListViewport, type ListViewportItem } from "../components/lists/ListViewport.js";
import { useAsyncResource } from "../hooks/use-async-resource.js";
import { type ResizableStdout } from "../hooks/use-terminal-size.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface ChatsScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
  readonly stdout?: ResizableStdout | undefined;
}

const EMPTY_LIST: () => Promise<readonly ChatListItem[]> = async () => [];

function resumeRoute(item: ChatListItem): string {
  return item.targetType === "panel"
    ? `/chat/panel/${encodeURIComponent(item.targetSlug)}`
    : `/chat/expert/${encodeURIComponent(item.targetSlug)}`;
}

export function ChatsScreen(props: ChatsScreenProps): React.ReactElement {
  const data = useData();
  const chats = data.chats as ChatsDataSource | undefined;
  const loadList = chats?.list ?? EMPTY_LIST;
  const state = useAsyncResource(loadList);
  const navigate = useNavigate();

  if (state.status === "loading") {
    return <Text>{props.theme.muted("Loading chats…")}</Text>;
  }

  if (state.status === "error") {
    return <Text>{props.theme.error("Failed to load chats")}</Text>;
  }

  const items: readonly ListViewportItem[] = state.data.map((item) => ({
    id: item.id,
    label: toSingleLineDisplay(
      `${chatTargetSymbol(item.targetType)} ${item.title}  ·  ${item.when}`,
    ),
  }));

  const chatData = state.data;

  return (
    <ListViewport
      items={items}
      isActive={props.isActive ?? false}
      onSelect={(id) => {
        const item = chatData.find((c) => c.id === id);
        if (item !== undefined) {
          navigate(resumeRoute(item));
        }
      }}
      theme={props.theme}
      title="Conversations"
      emptyText={props.theme.accent("No conversations yet — start one from an expert or panel")}
      stdout={props.stdout}
      renderPreview={(id) => {
        const item = chatData.find((c) => c.id === id);
        if (item === undefined) return null;
        return (
          <Box flexDirection="column">
            <Text bold>
              {chatTargetSymbol(item.targetType)} {toSingleLineDisplay(item.targetSlug)}
            </Text>
            <Text>{toSingleLineDisplay(item.title)}</Text>
            <Text>
              {item.status} · {item.when}
            </Text>
          </Box>
        );
      }}
    />
  );
}
