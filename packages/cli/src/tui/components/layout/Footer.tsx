import React from "react";
import { Box, Text } from "ink";

import { toSingleLineDisplay } from "../../../cli/strip-control-chars.js";
import type { SemanticTheme } from "../../theme/tokens.js";

export type FooterMode = "NAV" | "MAIN" | "INPUT" | "PALETTE" | "HELP" | "TYPE" | "STREAM";

export interface FooterHint {
  readonly key: string;
  readonly label: string;
}

export interface FooterProps {
  readonly hints: readonly FooterHint[];
  readonly mode: FooterMode;
  readonly status?: string;
  readonly showLabels?: boolean;
  readonly theme: SemanticTheme;
}

export function Footer(props: FooterProps): React.ReactElement {
  const showLabels = props.showLabels ?? true;
  const hintText = props.hints.map((h) => (showLabels ? `${h.key} ${h.label}` : h.key)).join("   ");
  return (
    <Box width="100%" justifyContent="space-between" paddingX={1}>
      <Text>{props.theme.muted(hintText)}</Text>
      <Text>
        {props.status !== undefined
          ? props.theme.muted(toSingleLineDisplay(props.status) + "   ")
          : ""}
        {props.theme.enabled ? (
          <Text inverse>{props.theme.primary(` ${props.mode} `)}</Text>
        ) : (
          props.theme.accent(props.mode)
        )}
      </Text>
    </Box>
  );
}
