import React from "react";
import { Box, Text } from "ink";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface PlaceholderScreenProps {
  readonly title: string;
  readonly theme: SemanticTheme;
}

export function PlaceholderScreen(props: PlaceholderScreenProps): React.ReactElement {
  return (
    <Box height="100%" alignItems="center" justifyContent="center" flexDirection="column">
      <Text>{props.theme.accent(toSingleLineDisplay(props.title))}</Text>
      <Text>{props.theme.muted("Coming soon")}</Text>
    </Box>
  );
}
