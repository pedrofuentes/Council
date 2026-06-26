import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { toSingleLineDisplay } from "../../../cli/strip-control-chars.js";
import type { SemanticTheme } from "../../theme/tokens.js";

export interface ActionMenuItem {
  readonly key: string;
  readonly label: string;
}

export interface ActionMenuProps {
  readonly items: readonly ActionMenuItem[];
  readonly isActive: boolean;
  readonly onSelect: (key: string) => void;
  readonly onClose: () => void;
  readonly theme: SemanticTheme;
}

export function ActionMenu(props: ActionMenuProps): React.ReactElement {
  const [selected, setSelected] = useState(0);

  useInput(
    (input, key) => {
      if (key.escape) {
        props.onClose();
        return;
      }
      if (key.return) {
        const item = props.items[selected];
        if (item !== undefined) props.onSelect(item.key);
        return;
      }
      if (key.upArrow || input === "k") {
        setSelected((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setSelected((s) => Math.min(props.items.length - 1, s + 1));
        return;
      }
    },
    { isActive: props.isActive },
  );

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text>{props.theme.accent("Actions")}</Text>
      {props.items.map((item, i) => (
        <Text key={item.key} inverse={i === selected}>
          {toSingleLineDisplay(`${item.key}  ${item.label}`)}
        </Text>
      ))}
    </Box>
  );
}
