import React from "react";
import { Box, Text, useInput } from "ink";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface CostConfirmModalProps {
  readonly theme: SemanticTheme;
  readonly experts: number;
  readonly rounds: number;
  readonly estimatedPremiumRequests: number;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly isActive?: boolean;
}

export function CostConfirmModal(props: CostConfirmModalProps): React.ReactElement {
  useInput(
    (input, key) => {
      if (input === "y" || key.return) {
        props.onConfirm();
        return;
      }
      if (input === "n") {
        props.onCancel();
      }
    },
    { isActive: props.isActive ?? true },
  );

  const line = toSingleLineDisplay(
    `Run debate with ${String(props.experts)} experts × ${String(props.rounds)} rounds (~${String(
      props.estimatedPremiumRequests,
    )} premium requests)? [y/n]`,
  );

  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text>{props.theme.accent(line)}</Text>
    </Box>
  );
}
