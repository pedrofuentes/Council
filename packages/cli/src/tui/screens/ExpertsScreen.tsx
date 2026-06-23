import React from "react";
import { Box, Text } from "ink";
import { useNavigate } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { ExpertListItem, ExpertsDataSource } from "../adapters/experts-data.js";
import { useData } from "../components/DataProvider.js";
import { SelectableList } from "../components/lists/SelectableList.js";
import { useAsyncResource } from "../hooks/use-async-resource.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface ExpertsScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

const EMPTY_LIST: () => Promise<readonly ExpertListItem[]> = async () => [];

export function ExpertsScreen(props: ExpertsScreenProps): React.ReactElement {
  const data = useData();
  const experts = data.experts as ExpertsDataSource | undefined;
  const loadList = experts?.loadList ?? EMPTY_LIST;
  const state = useAsyncResource(loadList);
  const navigate = useNavigate();

  if (state.status === "loading") {
    return <Text>{props.theme.muted("Loading experts…")}</Text>;
  }

  if (state.status === "error") {
    return <Text>{props.theme.error("Failed to load experts")}</Text>;
  }

  if (state.data.length === 0) {
    return (
      <Box justifyContent="center">
        <Text>{props.theme.accent("No experts yet — create one with e")}</Text>
      </Box>
    );
  }

  const rows = state.data.map((expert) =>
    toSingleLineDisplay(
      `${expert.slug}  ${expert.displayName} — ${expert.role} [${expert.kind}]  ${String(
        expert.panelCount,
      )} panels`,
    ),
  );

  return (
    <SelectableList
      items={rows}
      isActive={props.isActive ?? false}
      height={10}
      onActivate={(index) => {
        const expert = state.data[index];
        if (expert) {
          navigate(`/experts/${encodeURIComponent(expert.slug)}`);
        }
      }}
    />
  );
}
