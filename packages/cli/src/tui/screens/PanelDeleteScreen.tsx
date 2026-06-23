import React from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate, useParams } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { PanelAuthoringDataSource } from "../adapters/panel-authoring.js";
import { useData } from "../components/DataProvider.js";
import { useInputCapture } from "../components/InputCaptureProvider.js";
import { useAsyncResource } from "../hooks/use-async-resource.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface PanelDeleteScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

export function PanelDeleteScreen(props: PanelDeleteScreenProps): React.ReactElement {
  const { name } = useParams();
  const navigate = useNavigate();
  const panelAuthoring = useData().panelAuthoring as PanelAuthoringDataSource | undefined;
  const { setCaptured } = useInputCapture();
  const [removeError, setRemoveError] = React.useState<string | undefined>(undefined);
  const inFlight = React.useRef(false);
  const isActive = props.isActive ?? true;

  React.useEffect(() => {
    setCaptured(true);
    return () => {
      setCaptured(false);
    };
  }, [setCaptured]);

  const loader = React.useCallback(
    () => (panelAuthoring ? panelAuthoring.countRetainedDebates(name ?? "") : Promise.resolve(0)),
    [name, panelAuthoring],
  );
  const state = useAsyncResource(loader);

  useInput(
    (input, key) => {
      if (key.escape) {
        if (!inFlight.current) {
          navigate(-1);
        }
        return;
      }

      if (input === "n") {
        navigate(-1);
        return;
      }

      if (input === "y") {
        if (state.status !== "loaded" || inFlight.current || panelAuthoring === undefined) {
          return;
        }

        inFlight.current = true;
        setRemoveError(undefined);
        void (async (): Promise<void> => {
          try {
            await panelAuthoring.delete(name ?? "");
            navigate("/panels");
          } catch (err) {
            inFlight.current = false;
            setRemoveError(toSingleLineDisplay(err instanceof Error ? err.message : String(err)));
          }
        })();
      }
    },
    { isActive },
  );

  if (panelAuthoring === undefined) {
    return <Text>{props.theme.error(toSingleLineDisplay("Panel delete unavailable"))}</Text>;
  }

  if (state.status === "loading") {
    return <Text>{props.theme.muted(toSingleLineDisplay("Loading…"))}</Text>;
  }

  if (state.status === "error") {
    return (
      <Text>
        {props.theme.error(toSingleLineDisplay(`Failed to load: ${state.error.message}`))}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>
        {props.theme.warn(
          toSingleLineDisplay(
            `Delete panel "${name ?? ""}"? ${state.data} saved session(s) will be kept. [y/n]`,
          ),
        )}
      </Text>
      {removeError !== undefined ? <Text>{props.theme.error(removeError)}</Text> : undefined}
      <Text>
        {props.theme.accent(toSingleLineDisplay("Press y to delete, n or Esc to cancel"))}
      </Text>
    </Box>
  );
}
