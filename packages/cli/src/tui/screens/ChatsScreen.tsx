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
import { SelectableList } from "../components/lists/SelectableList.js";
import { useAsyncResource } from "../hooks/use-async-resource.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface ChatsScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
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

  if (state.data.length === 0) {
    return (
      <Box justifyContent="center">
        <Text>{props.theme.accent("No chats yet — start one from an expert or panel")}</Text>
      </Box>
    );
  }

  const rows = state.data.map((item) =>
    toSingleLineDisplay(`${chatTargetSymbol(item.targetType)} ${item.title}  ·  ${item.when}`),
  );

  return (
    <SelectableList
      items={rows}
      isActive={props.isActive ?? false}
      height={10}
      onActivate={(index) => {
        const item = state.data[index];
        if (item !== undefined) {
          navigate(resumeRoute(item));
        }
      }}
    />
  );
}
