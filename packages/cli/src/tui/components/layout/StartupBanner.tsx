import React from "react";
import { Box, Text, useInput } from "ink";

import { toSingleLineDisplay } from "../../../cli/strip-control-chars.js";
import type { StartupWarning } from "../../lib/startup-warnings.js";
import type { SemanticTheme } from "../../theme/tokens.js";
import { useInputCapture } from "../InputCaptureProvider.js";

export interface StartupBannerProps {
  readonly warnings: readonly StartupWarning[];
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
  readonly onDismiss?: () => void;
}

const HEADING = "Startup notices";
const DISMISS_HINT = "Esc dismiss";

/**
 * Dismissible startup banner for config-load warnings and the "update available"
 * notice. Renders nothing when there are no warnings, so it is inert on a normal
 * launch. While visible it captures input (so the underlying screen ignores
 * keystrokes) and is dismissed by Esc/Enter. Every untrusted warning string is
 * collapsed/stripped with `toSingleLineDisplay` at the `<Text>` sink so a
 * crafted notice cannot forge a line or inject terminal-control sequences.
 */
export function StartupBanner(props: StartupBannerProps): React.ReactElement | null {
  const { setCaptured } = useInputCapture();
  const [dismissed, setDismissed] = React.useState(false);

  const visible = props.warnings.length > 0 && !dismissed;
  const active = visible && (props.isActive ?? true);

  React.useEffect(() => {
    // Only take over input capture while actually showing notices; when there is
    // nothing to show, leave the shared capture state untouched so we never
    // clobber a screen that has captured input for itself.
    if (!visible) {
      return;
    }
    setCaptured(true);
    return () => {
      setCaptured(false);
    };
  }, [visible, setCaptured]);

  useInput(
    (_input, key) => {
      if (key.escape || key.return) {
        setDismissed(true);
        props.onDismiss?.();
      }
    },
    { isActive: active },
  );

  if (!visible) {
    return null;
  }

  const lineFor = (warning: StartupWarning): string => {
    const safe = toSingleLineDisplay(warning.text);
    return warning.kind === "update" ? props.theme.accent(safe) : props.theme.warn(safe);
  };

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text>{props.theme.warn(toSingleLineDisplay(HEADING))}</Text>
      {props.warnings.map((warning, index) => (
        <Text key={index}>{lineFor(warning)}</Text>
      ))}
      <Text>{props.theme.muted(toSingleLineDisplay(DISMISS_HINT))}</Text>
    </Box>
  );
}
