import React from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import { SelectableList } from "../components/lists/SelectableList.js";
import { useData } from "../components/DataProvider.js";
import { useAsyncResource } from "../hooks/use-async-resource.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface PanelsScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

export function PanelsScreen(props: PanelsScreenProps): React.ReactElement {
  const data = useData();
  const state = useAsyncResource(data.panels.loadList);
  const navigate = useNavigate();

  useInput(
    (input) => {
      if (input === "n") {
        navigate("/panels/new");
      }
    },
    { isActive: props.isActive ?? false },
  );

  if (state.status === "loading") {
    return <Text>{props.theme.muted("Loading panels…")}</Text>;
  }

  if (state.status === "error") {
    return <Text>{props.theme.error("Failed to load panels")}</Text>;
  }

  if (state.data.length === 0) {
    return (
      <Box justifyContent="center">
        <Text>
          {props.theme.accent("No panels yet — create one with n (or auto-compose with c)")}
        </Text>
      </Box>
    );
  }

  const rows = state.data.map((panel) => {
    const name = toSingleLineDisplay(panel.name);
    const description = toSingleLineDisplay(panel.description);
    const prefix = `${name}  ${panel.memberCount} experts`;
    return description === "" ? prefix : `${prefix}  ${description}`;
  });

  return (
    <SelectableList
      items={rows}
      isActive={props.isActive ?? false}
      height={10}
      onActivate={(index) => {
        const panel = state.data[index];
        if (panel) {
          navigate(`/panels/${encodeURIComponent(panel.name)}`, {
            state: { source: panel.source },
          });
        }
      }}
    />
  );
}
