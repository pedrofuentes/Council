import React from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { SettingsDataSource, SettingsFieldState } from "../adapters/config-settings.js";
import { useData } from "../components/DataProvider.js";
import { useInputCapture } from "../components/InputCaptureProvider.js";
import { useAsyncResource } from "../hooks/use-async-resource.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface SettingsScreenProps {
  readonly theme: SemanticTheme;
}

const EMPTY: () => Promise<readonly SettingsFieldState[]> = async () => [];

export function SettingsScreen(props: SettingsScreenProps): React.ReactElement {
  const data = useData();
  const settings = data.settings as SettingsDataSource | undefined;
  const load = settings?.load ?? EMPTY;
  const state = useAsyncResource(load);
  const { setCaptured } = useInputCapture();
  const navigate = useNavigate();
  const [cursor, setCursor] = React.useState(0);

  React.useEffect(() => {
    setCaptured(true);
    return () => {
      setCaptured(false);
    };
  }, [setCaptured]);

  useInput((input, key) => {
    if (key.escape) {
      navigate(-1);
      return;
    }

    if (state.status !== "loaded" || state.data.length === 0) {
      return;
    }

    const lastIndex = state.data.length - 1;
    if (key.downArrow || input === "j" || (key.tab && key.shift !== true)) {
      setCursor((c) => Math.min(lastIndex, c + 1));
      return;
    }
    if (key.upArrow || input === "k" || (key.tab && key.shift === true)) {
      setCursor((c) => Math.max(0, c - 1));
    }
  });

  if (state.status === "loading") {
    return <Text>{props.theme.muted("Loading settings…")}</Text>;
  }

  if (state.status === "error") {
    return <Text>{props.theme.error("Failed to load settings")}</Text>;
  }

  let previousSection: string | undefined;

  return (
    <Box flexDirection="column">
      {state.data.map((field, index) => {
        const showSection = field.section !== previousSection;
        previousSection = field.section;
        return (
          <React.Fragment key={field.path}>
            {showSection ? (
              <Text>{props.theme.accent(toSingleLineDisplay(field.section))}</Text>
            ) : null}
            <Text inverse={index === cursor}>
              {toSingleLineDisplay(`  ${field.label}: ${field.value}`)}
            </Text>
          </React.Fragment>
        );
      })}
      <Text>{props.theme.muted("↑↓ move · Esc back")}</Text>
    </Box>
  );
}
