import React from "react";
import { Box, Text } from "ink";

import type { LayoutPlan } from "../../lib/breakpoints.js";

export interface AppShellProps {
  readonly layout: LayoutPlan;
  readonly header: React.ReactNode;
  readonly footer: React.ReactNode;
  readonly nav?: React.ReactNode;
  readonly children: React.ReactNode;
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
  return (
    <Box flexDirection="column" height="100%">
      {props.header}
      <Box flexGrow={1}>
        {showNav ? <Box>{props.nav}</Box> : null}
        <Box flexGrow={1} flexDirection="column">
          {props.children}
        </Box>
      </Box>
      {props.footer}
    </Box>
  );
}
