// packages/cli/src/tui/components/lists/ScrollView.tsx
import React from "react";
import { Box, Text } from "ink";

import { computeScrollWindow } from "../../lib/scroll.js";

export interface ScrollViewProps {
  readonly items: readonly string[];
  readonly height: number;
  readonly cursor?: number;
  readonly follow?: boolean;
}

export function ScrollView(props: ScrollViewProps): React.ReactElement {
  const cursor = props.cursor ?? -1;
  const follow = props.follow ?? false;
  const { start, end } = computeScrollWindow({
    total: props.items.length,
    viewport: props.height,
    cursor,
    offset: 0,
    follow,
  });

  const visible = props.items.slice(start, end);
  return (
    <Box flexDirection="column">
      {visible.map((item, i) => {
        const index = start + i;
        return (
          <Text key={index} inverse={index === cursor}>
            {item}
          </Text>
        );
      })}
    </Box>
  );
}
