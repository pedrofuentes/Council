import React from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { OnboardingDataSource, OnboardingView } from "../adapters/onboarding.js";
import { useData } from "../components/DataProvider.js";
import { useInputCapture } from "../components/InputCaptureProvider.js";
import { useAsyncResource } from "../hooks/use-async-resource.js";
import { ROUTES } from "../router/routes.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface OnboardingScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
  /**
   * Invoked after the chosen model is persisted, in place of navigating home.
   * `launchTui` wires this to a full session restart so the freshly persisted
   * `defaults.model` is applied to the live session (header, engine factories,
   * data-source default models). When absent — e.g. isolated screen tests —
   * the screen falls back to client-side navigation home.
   */
  readonly onComplete?: (() => void) | undefined;
}

type PersistState =
  | { readonly kind: "idle" }
  | { readonly kind: "persisting" }
  | { readonly kind: "error"; readonly message: string };

function errorMessage(err: unknown): string {
  return toSingleLineDisplay(err instanceof Error ? err.message : String(err));
}

export function OnboardingScreen(props: OnboardingScreenProps): React.ReactElement {
  const data = useData();
  const onboarding = data.onboarding as OnboardingDataSource | undefined;
  const navigate = useNavigate();
  const { setCaptured } = useInputCapture();
  const loader = React.useCallback(
    () => (onboarding ? onboarding.load() : Promise.resolve<OnboardingView | undefined>(undefined)),
    [onboarding],
  );
  const state = useAsyncResource(loader);
  const [cursor, setCursor] = React.useState(0);
  const [persist, setPersist] = React.useState<PersistState>({ kind: "idle" });
  const inFlight = React.useRef(false);
  const isActive = props.isActive ?? true;
  const { onComplete } = props;

  React.useEffect(() => {
    setCaptured(true);
    return () => {
      setCaptured(false);
    };
  }, [setCaptured]);

  const view = state.status === "loaded" ? state.data : undefined;
  const models = view?.models ?? [];

  const confirm = React.useCallback(async (): Promise<void> => {
    if (inFlight.current || onboarding === undefined) return;
    const option = models[cursor];
    if (option === undefined) return;
    inFlight.current = true;
    setPersist({ kind: "persisting" });
    try {
      await onboarding.complete(option.id);
      // Persisting `defaults.model` only updates config.yaml; the running TUI
      // session was built from the pre-onboarding config. Hand control to the
      // restart hook so launchTui re-initialises with the new default model.
      // Without a hook (isolated screen tests), fall back to navigating home.
      if (onComplete !== undefined) {
        onComplete();
      } else {
        navigate(ROUTES.home, { replace: true });
      }
    } catch (err) {
      setPersist({ kind: "error", message: errorMessage(err) });
    } finally {
      inFlight.current = false;
    }
  }, [cursor, models, navigate, onboarding, onComplete]);

  useInput(
    (input, key) => {
      if (key.escape) {
        if (!inFlight.current) navigate(ROUTES.home, { replace: true });
        return;
      }
      if (models.length === 0) {
        return;
      }
      if (key.downArrow || input === "j") {
        setCursor((current) => Math.min(models.length - 1, current + 1));
        return;
      }
      if (key.upArrow || input === "k") {
        setCursor((current) => Math.max(0, current - 1));
        return;
      }
      if (key.return) {
        void confirm();
      }
    },
    { isActive },
  );

  if (onboarding === undefined) {
    return <Text>{props.theme.error(toSingleLineDisplay("Onboarding unavailable"))}</Text>;
  }

  if (state.status === "loading") {
    return <Text>{props.theme.muted(toSingleLineDisplay("Preparing first-run setup…"))}</Text>;
  }

  if (state.status === "error") {
    return <Text>{props.theme.error(toSingleLineDisplay("Failed to start onboarding"))}</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text>{props.theme.accent(toSingleLineDisplay("Welcome to Council!"))}</Text>
      <Text>
        {props.theme.muted(
          toSingleLineDisplay("Choose the default AI model your expert panels will use."),
        )}
      </Text>
      {view?.usedFallback === true ? (
        <Text>
          {props.theme.warn(
            toSingleLineDisplay("Live model discovery failed; showing a built-in fallback list."),
          )}
        </Text>
      ) : null}
      {models.length === 0 ? (
        <Text>
          {props.theme.muted(
            toSingleLineDisplay(
              "No models available — press Esc to skip and set one later in Settings.",
            ),
          )}
        </Text>
      ) : (
        models.map((option, index) => (
          <Text key={option.id} inverse={index === cursor}>
            {toSingleLineDisplay(`  ${option.label}${option.recommended ? " (recommended)" : ""}`)}
          </Text>
        ))
      )}
      {persist.kind === "persisting" ? (
        <Text>{props.theme.muted(toSingleLineDisplay("Saving your choice…"))}</Text>
      ) : null}
      {persist.kind === "error" ? <Text>{props.theme.error(persist.message)}</Text> : null}
      <Text>{props.theme.muted(toSingleLineDisplay("↑↓ move · Enter confirm · Esc skip"))}</Text>
    </Box>
  );
}
