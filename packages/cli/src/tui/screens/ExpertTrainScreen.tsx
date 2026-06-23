import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useParams } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type {
  ExpertTrainingDataSource,
  TrainingProgress,
  TrainingResultView,
} from "../adapters/expert-training.js";
import { useData } from "../components/DataProvider.js";
import { useInputCapture } from "../components/InputCaptureProvider.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface ExpertTrainScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

type TrainState =
  | { readonly status: "idle" }
  | { readonly status: "training" }
  | { readonly status: "done"; readonly result: TrainingResultView }
  | { readonly status: "error"; readonly message: string };

function renderProgress(progress: TrainingProgress): string {
  if (progress.status === "failed") {
    return `${progress.filename}: failed (${progress.error ?? "unknown"})`;
  }
  if (progress.status === "needs-review") {
    return `${progress.filename}: needs review`;
  }
  return `${progress.filename}: ${progress.wordCount} words`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ExpertTrainScreen(props: ExpertTrainScreenProps): React.ReactElement {
  const { slug } = useParams();
  const data = useData();
  const training = data.training as ExpertTrainingDataSource | undefined;
  const { setCaptured } = useInputCapture();
  const [filePath, setFilePath] = React.useState("");
  const [state, setState] = React.useState<TrainState>({ status: "idle" });
  const [progress, setProgress] = React.useState<readonly TrainingProgress[]>([]);
  const inFlight = React.useRef(false);

  React.useEffect(() => {
    setCaptured(true);
    return () => {
      setCaptured(false);
    };
  }, [setCaptured]);

  const submit = React.useCallback(
    (value: string): void => {
      const trimmed = value.trim();
      if (trimmed.length === 0 || inFlight.current) {
        return;
      }
      if (training === undefined) {
        setState({ status: "error", message: "training unavailable" });
        return;
      }

      inFlight.current = true;
      setProgress([]);
      setState({ status: "training" });
      void training
        .train(slug ?? "", { files: [trimmed] }, (item) => {
          setProgress((current) => [...current, item]);
        })
        .then((result) => {
          setState({ status: "done", result });
        })
        .catch((error: unknown) => {
          setState({ status: "error", message: toSingleLineDisplay(errorMessage(error)) });
        })
        .finally(() => {
          inFlight.current = false;
        });
    },
    [slug, training],
  );

  useInput(
    (_input, key) => {
      if (key.return) {
        submit(filePath);
      }
    },
    { isActive: props.isActive ?? false },
  );

  return (
    <Box flexDirection="column">
      <Box>
        <Text>{props.theme.accent("Document file path: ")}</Text>
        <TextInput
          focus={(props.isActive ?? false) && state.status !== "training"}
          onChange={setFilePath}
          onSubmit={submit}
          value={toSingleLineDisplay(filePath)}
        />
      </Box>
      {state.status === "training" ? <Text>{props.theme.muted("Training persona…")}</Text> : null}
      {progress.map((item, index) => (
        <Text key={`${item.filename}-${String(index)}`}>
          {toSingleLineDisplay(renderProgress(item))}
        </Text>
      ))}
      {state.status === "done" ? (
        <>
          <Text>
            {toSingleLineDisplay(
              `Processed ${state.result.filesProcessed} document(s) ` +
                `(${state.result.filesFailed} failed, ${state.result.filesNeedingReview} needs review, ` +
                `${state.result.totalWords} words)`,
            )}
          </Text>
          {state.result.profileError !== null ? (
            <Text>
              {props.theme.error(
                toSingleLineDisplay(`Profile refresh failed: ${state.result.profileError}`),
              )}
            </Text>
          ) : state.result.profileUpdated ? (
            <Text>{props.theme.success("✓ Persona profile updated.")}</Text>
          ) : null}
        </>
      ) : null}
      {state.status === "error" ? (
        <Text>{props.theme.error(toSingleLineDisplay(`Training failed: ${state.message}`))}</Text>
      ) : null}
    </Box>
  );
}
