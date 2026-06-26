import React from "react";
import { Box, Text } from "ink";

import type { LayoutPlan } from "../../lib/breakpoints.js";
import type { SemanticTheme } from "../../theme/tokens.js";

export type FocusTarget = "nav" | "main";

export interface AppShellProps {
  readonly layout: LayoutPlan;
  readonly header: React.ReactNode;
  readonly footer: React.ReactNode;
  readonly nav?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly theme?: SemanticTheme;
  readonly focus?: FocusTarget;
  readonly mainTitle?: string;
}

// Ink `borderColor` accepts a chalk color name. These mirror the theme's
// `primary`/`muted` roles so the focused pane reads as a bright focus ring and
// the unfocused pane recedes. Only applied when the theme enables color.
const FOCUSED_BORDER_COLOR = "cyan";
const UNFOCUSED_BORDER_COLOR = "gray";

const identity = (s: string): string => s;
const NO_COLOR_THEME: SemanticTheme = {
  enabled: false,
  accent: identity,
  muted: identity,
  error: identity,
  warn: identity,
  success: identity,
  primary: identity,
  secondary: identity,
  info: identity,
};

/**
 * Returns the Ink `borderColor` value for a pane based on focus state and theme.
 * Returns `undefined` when color is disabled (NO_COLOR / TERM=dumb) so no
 * border color attribute is applied.
 */
export function paneBorderColor(focused: boolean, theme: SemanticTheme): string | undefined {
  if (!theme.enabled) return undefined;
  return focused ? FOCUSED_BORDER_COLOR : UNFOCUSED_BORDER_COLOR;
}

function PaneTitle(props: {
  readonly label: string;
  readonly focused: boolean;
  readonly theme?: SemanticTheme | undefined;
}): React.ReactElement {
  const theme = props.theme;
  if (theme === undefined || !theme.enabled) {
    return <Text>{props.label}</Text>;
  }
  return <Text>{props.focused ? theme.primary(props.label) : theme.muted(props.label)}</Text>;
}

export function AppShell(props: AppShellProps): React.ReactElement {
  if (props.layout.tooNarrow) {
    return (
      <Box height="100%" alignItems="center" justifyContent="center">
        <Text>Terminal too narrow (min 60 cols)</Text>
      </Box>
    );
  }
  const showNav = props.layout.navState !== "hidden" && props.nav !== undefined;
  const focus = props.focus ?? "main";
  const navFocused = focus === "nav";
  const mainFocused = focus === "main";
  const effectiveTheme = props.theme ?? NO_COLOR_THEME;
  const navBorderColor = paneBorderColor(navFocused, effectiveTheme);
  const mainBorderColor = paneBorderColor(mainFocused, effectiveTheme);
  const mainTitle = props.mainTitle;
  return (
    <Box flexDirection="column" width={props.layout.columns} height={props.layout.rows}>
      {props.header}
      <Box flexGrow={1}>
        {showNav ? (
          <Box flexDirection="column" borderStyle="round" borderColor={navBorderColor}>
            <PaneTitle label="Nav" focused={navFocused} theme={props.theme} />
            {props.nav}
          </Box>
        ) : null}
        <Box flexGrow={1} flexDirection="column" borderStyle="round" borderColor={mainBorderColor}>
          {mainTitle !== undefined && mainTitle !== "" ? (
            <PaneTitle label={mainTitle} focused={mainFocused} theme={props.theme} />
          ) : null}
          <Box flexGrow={1} flexDirection="column">
            {props.children}
          </Box>
        </Box>
      </Box>
      {props.footer}
    </Box>
  );
}
