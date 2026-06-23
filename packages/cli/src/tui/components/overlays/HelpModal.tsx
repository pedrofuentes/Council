import React from "react";
import { Box, Text, useInput } from "ink";

import type { SemanticTheme } from "../../theme/tokens.js";

export interface HelpEntry {
  readonly keys: string;
  readonly description: string;
}

export interface HelpModalProps {
  readonly entries: readonly HelpEntry[];
  readonly onClose: () => void;
  readonly isActive?: boolean;
  readonly theme: SemanticTheme;
}

export function HelpModal(props: HelpModalProps): React.ReactElement {
  const isActive = props.isActive ?? true;
  useInput(
    (input, key) => {
      if (key.escape || input === "?") props.onClose();
    },
    { isActive },
  );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text>{props.theme.accent("Keyboard shortcuts")}</Text>
      {props.entries.map((e) => (
        <Text key={e.keys}>{`  ${e.keys}  ${e.description}`}</Text>
      ))}
    </Box>
  );
}
