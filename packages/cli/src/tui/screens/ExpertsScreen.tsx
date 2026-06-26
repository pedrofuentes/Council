import React, { useState } from "react";
import { Text, useInput } from "ink";
import { useNavigate } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { ExpertListItem, ExpertsDataSource } from "../adapters/experts-data.js";
import { useData } from "../components/DataProvider.js";
import { ListViewport, type ListViewportItem } from "../components/lists/ListViewport.js";
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
  const [isFiltering, setIsFiltering] = useState(false);

  useInput(
    (input) => {
      if (input === "n") {
        navigate("/experts/new");
      }
    },
    { isActive: (props.isActive ?? false) && !isFiltering },
  );

  if (state.status === "loading") {
    return <Text>{props.theme.muted("Loading experts…")}</Text>;
  }

  if (state.status === "error") {
    return <Text>{props.theme.error("Failed to load experts")}</Text>;
  }

  const items: readonly ListViewportItem[] = state.data.map((expert) => ({
    id: expert.slug,
    label: toSingleLineDisplay(
      `${expert.slug}  ${expert.displayName} — ${expert.role} [${expert.kind}]  ${String(
        expert.panelCount,
      )} panels`,
    ),
  }));

  return (
    <ListViewport
      items={items}
      isActive={props.isActive ?? false}
      onSelect={(id) => {
        navigate(`/experts/${encodeURIComponent(id)}`);
      }}
      theme={props.theme}
      title="Experts"
      emptyText={props.theme.accent(
        "No experts yet — [n] create one. Experts are the members of your panels.",
      )}
      onFilterModeChange={setIsFiltering}
    />
  );
}
