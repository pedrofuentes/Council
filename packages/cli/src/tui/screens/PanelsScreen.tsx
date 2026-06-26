import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import { useData } from "../components/DataProvider.js";
import { ListViewport, type ListViewportItem } from "../components/lists/ListViewport.js";
import { useAsyncResource } from "../hooks/use-async-resource.js";
import { type ResizableStdout } from "../hooks/use-terminal-size.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface PanelsScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
  readonly stdout?: ResizableStdout | undefined;
}

export function PanelsScreen(props: PanelsScreenProps): React.ReactElement {
  const data = useData();
  const state = useAsyncResource(data.panels.loadList);
  const navigate = useNavigate();
  const [isFiltering, setIsFiltering] = useState(false);

  useInput(
    (input) => {
      if (input === "n") {
        navigate("/panels/new");
        return;
      }
      if (input === "c") {
        navigate("/panels/compose");
      }
    },
    { isActive: (props.isActive ?? false) && !isFiltering },
  );

  if (state.status === "loading") {
    return <Text>{props.theme.muted("Loading panels…")}</Text>;
  }

  if (state.status === "error") {
    return <Text>{props.theme.error("Failed to load panels")}</Text>;
  }

  const items: readonly ListViewportItem[] = state.data.map((panel) => {
    const name = toSingleLineDisplay(panel.name);
    const description = toSingleLineDisplay(panel.description);
    const prefix = `${name}  ${panel.memberCount} experts`;
    return {
      id: `${panel.source}:${panel.name}`,
      label: description === "" ? prefix : `${prefix}  ${description}`,
    };
  });

  const panelData = state.data;

  return (
    <ListViewport
      items={items}
      isActive={props.isActive ?? false}
      onSelect={(id) => {
        const panel = panelData.find((p) => `${p.source}:${p.name}` === id);
        if (panel !== undefined) {
          navigate(`/panels/${encodeURIComponent(panel.name)}`, {
            state: { source: panel.source },
          });
        }
      }}
      theme={props.theme}
      title="Panels"
      emptyText={props.theme.accent(
        "No panels yet — [c] auto-compose from a topic, or [n] build from experts",
      )}
      onFilterModeChange={setIsFiltering}
      stdout={props.stdout}
      renderPreview={(id) => {
        const panel = panelData.find((p) => `${p.source}:${p.name}` === id);
        if (panel === undefined) return null;
        const name = toSingleLineDisplay(panel.name);
        const description = toSingleLineDisplay(panel.description);
        return (
          <Box flexDirection="column">
            <Text bold>{name}</Text>
            <Text>
              {String(panel.memberCount)} members · {panel.source}
            </Text>
            {description !== "" && <Text>{description}</Text>}
          </Box>
        );
      }}
    />
  );
}
