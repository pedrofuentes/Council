import React from "react";
import { Box, Text } from "ink";

import { toSingleLineDisplay } from "../../../cli/strip-control-chars.js";
import type { SemanticTheme } from "../../theme/tokens.js";

export interface HeaderProps {
  readonly breadcrumb: string;
  readonly model: string;
  readonly premiumRequests?: number;
  readonly compact?: boolean;
  readonly theme: SemanticTheme;
}

export function Header(props: HeaderProps): React.ReactElement {
  const breadcrumb = toSingleLineDisplay(props.breadcrumb);
  const model = toSingleLineDisplay(props.model);
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text>{props.theme.accent(`🏛 ${breadcrumb}`)}</Text>
      {props.compact !== true && (
        <Text>
          {props.theme.muted(model)}
          {props.premiumRequests !== undefined ? props.theme.muted(`  ◷ ${props.premiumRequests} req`) : ""}
        </Text>
      )}
    </Box>
  );
}
