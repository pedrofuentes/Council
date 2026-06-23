import React from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate, useParams } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { ExpertAuthoringSource } from "../adapters/expert-authoring.js";
import { useData } from "../components/DataProvider.js";
import { useInputCapture } from "../components/InputCaptureProvider.js";
import { useAsyncResource } from "../hooks/use-async-resource.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface ExpertDeleteScreenProps {
  readonly theme: SemanticTheme;
}

export function ExpertDeleteScreen(props: ExpertDeleteScreenProps): React.ReactElement {
  const params = useParams();
  const slug = params.slug ?? "";
  const navigate = useNavigate();
  const expertAuthoring = useData().expertAuthoring as ExpertAuthoringSource | undefined;
  const { setCaptured } = useInputCapture();
  const [deleteError, setDeleteError] = React.useState<string | undefined>(undefined);
  const deletingRef = React.useRef(false);

  React.useEffect(() => {
    setCaptured(true);
    return () => {
      setCaptured(false);
    };
  }, [setCaptured]);

  const loader = React.useCallback(
    () =>
      expertAuthoring
        ? expertAuthoring.affectedPanels(slug)
        : Promise.resolve<readonly string[]>([]),
    [expertAuthoring, slug],
  );
  const state = useAsyncResource(loader);

  const confirmDelete = React.useCallback(async (): Promise<void> => {
    if (deletingRef.current) {
      return;
    }

    deletingRef.current = true;
    setDeleteError(undefined);

    try {
      await expertAuthoring?.remove(slug);
      navigate("/experts");
    } catch (error) {
      deletingRef.current = false;
      setDeleteError(toSingleLineDisplay(String(error)));
    }
  }, [expertAuthoring, navigate, slug]);

  useInput((input, key) => {
    if (input === "n" || key.escape) {
      navigate(-1);
      return;
    }
    if (input === "y" && state.status === "loaded") {
      void confirmDelete();
    }
  });

  if (state.status === "loading") {
    return <Text>{props.theme.muted("Loading…")}</Text>;
  }

  if (state.status === "error") {
    return <Text>{props.theme.error("Failed to load")}</Text>;
  }

  const panels = state.data;

  return (
    <Box flexDirection="column">
      <Text>{props.theme.warn(toSingleLineDisplay(`Delete expert "${slug}"?`))}</Text>
      {panels.length > 0 ? (
        <Text>
          {props.theme.warn(
            toSingleLineDisplay(
              `Used in ${panels.length} panel(s): ${panels
                .map(toSingleLineDisplay)
                .join(", ")} — it will be removed from them.`,
            ),
          )}
        </Text>
      ) : (
        <Text>{props.theme.muted("Not used in any panels.")}</Text>
      )}
      {deleteError !== undefined ? <Text>{props.theme.error(deleteError)}</Text> : undefined}
      <Text>{props.theme.accent("Press y to delete, n or Esc to cancel")}</Text>
    </Box>
  );
}
