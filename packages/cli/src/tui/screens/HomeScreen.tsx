// packages/cli/src/tui/screens/HomeScreen.tsx
import React from "react";
import { Box, Text } from "ink";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { HomeData } from "../adapters/home-data.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface HomeScreenProps {
  readonly data: HomeData;
  readonly theme: SemanticTheme;
}

const QUICK_ACTIONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "c", label: "Convene" },
  { key: "e", label: "New expert" },
  { key: "p", label: "New panel" },
  { key: ",", label: "Settings" },
];

export function HomeScreen(props: HomeScreenProps): React.ReactElement {
  const { counts, recent } = props.data;
  const empty = counts.sessions === 0 && counts.experts === 0 && counts.panels === 0;
  if (empty) {
    return (
      <Box height="100%" alignItems="center" justifyContent="center">
        <Text>{props.theme.accent("⊕ Start your first Council session  [c]")}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>{props.theme.muted("Recent sessions")}</Text>
      {recent.map((s) => (
        <Text key={s.id}>
          {`  ${s.status === "concluded" ? "✓" : "•"} ${toSingleLineDisplay(s.title)}  ${toSingleLineDisplay(s.when)}`}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text>{props.theme.muted(`${counts.sessions} sessions · ${counts.experts} experts · ${counts.panels} panels`)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>{QUICK_ACTIONS.map((a) => `${a.key} ${a.label}`).join("   ")}</Text>
      </Box>
    </Box>
  );
}
