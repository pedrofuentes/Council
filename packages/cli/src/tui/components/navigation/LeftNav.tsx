// packages/cli/src/tui/components/navigation/LeftNav.tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { toSingleLineDisplay } from "../../../cli/strip-control-chars.js";
import type { NavState } from "../../lib/breakpoints.js";
import type { SemanticTheme } from "../../theme/tokens.js";

export interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly glyph: string;
}

export interface LeftNavProps {
  readonly items: readonly NavItem[];
  readonly activeId: string;
  readonly state: NavState;
  readonly onSelect: (id: string) => void;
  readonly isActive?: boolean;
  readonly theme: SemanticTheme;
}

export function LeftNav(props: LeftNavProps): React.ReactElement {
  const isActive = props.isActive ?? true;
  const initial = Math.max(0, props.items.findIndex((i) => i.id === props.activeId));
  const [cursor, setCursor] = useState(initial);
  const count = props.items.length;

  useInput(
    (input, key) => {
      if (key.downArrow || input === "j") {
        setCursor((c) => (count === 0 ? 0 : (c + 1) % count));
        return;
      }
      if (key.upArrow || input === "k") {
        setCursor((c) => (count === 0 ? 0 : (c - 1 + count) % count));
        return;
      }
      if (key.return) {
        const item = props.items[Math.min(cursor, count - 1)];
        if (item) props.onSelect(item.id);
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      {props.items.map((item, i) => {
        const label = toSingleLineDisplay(item.label);
        const text = props.state === "rail" ? item.glyph : `${item.glyph} ${label}`;
        return (
          <Text key={item.id} inverse={i === cursor}>
            {text}
          </Text>
        );
      })}
    </Box>
  );
}
