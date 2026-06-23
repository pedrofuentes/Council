import React from "react";
import { Box, Text, useInput } from "ink";
import { useParams } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { ExpertDocumentsDataSource } from "../adapters/expert-documents.js";
import { useData } from "../components/DataProvider.js";
import { SelectableList } from "../components/lists/SelectableList.js";
import { useAsyncResource } from "../hooks/use-async-resource.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface ExpertDocumentsScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

export function ExpertDocumentsScreen(props: ExpertDocumentsScreenProps): React.ReactElement {
  const { slug } = useParams();
  const slugValue = slug ?? "";
  const data = useData();
  const documents = data.documents as ExpertDocumentsDataSource | undefined;
  const [reloadKey, setReloadKey] = React.useState(0);
  const [confirmIndex, setConfirmIndex] = React.useState<number | null>(null);
  const [removeError, setRemoveError] = React.useState<string | undefined>(undefined);
  const [removeWarning, setRemoveWarning] = React.useState<string | undefined>(undefined);
  const removingRef = React.useRef(false);
  const loader = React.useCallback(
    () => (documents ? documents.list(slugValue) : Promise.resolve([])),
    [documents, slugValue, reloadKey],
  );
  const state = useAsyncResource(loader);

  useInput(
    (input) => {
      if (confirmIndex === null || state.status !== "loaded") return;
      const document = state.data[confirmIndex];
      if (input === "n") {
        setConfirmIndex(null);
        setRemoveError(undefined);
        setRemoveWarning(undefined);
        return;
      }
      if (input === "y" && document !== undefined && !removingRef.current) {
        removingRef.current = true;
        setRemoveError(undefined);
        setRemoveWarning(undefined);
        void (async (): Promise<void> => {
          try {
            const result = await documents?.remove(slugValue, document.id);
            setConfirmIndex(null);
            setReloadKey((key) => key + 1);
            if (result?.ftsCleanupFailed === true) {
              setRemoveWarning(
                toSingleLineDisplay(
                  `"${document.filename}" removed from tracking, but the search index ` +
                    `could not be cleaned up. Re-train this persona to repair the index.`,
                ),
              );
            }
          } catch (error) {
            setRemoveError(toSingleLineDisplay(String(error)));
          } finally {
            removingRef.current = false;
          }
        })();
      }
    },
    { isActive: (props.isActive ?? false) && confirmIndex !== null && state.status === "loaded" },
  );

  if (state.status === "loading") {
    return <Text>{props.theme.muted("Loading documents…")}</Text>;
  }

  if (state.status === "error") {
    return <Text>{props.theme.error("Failed to load documents")}</Text>;
  }

  const documentsList = state.data;
  const rows = documentsList.map((document) =>
    toSingleLineDisplay(
      `${document.filename}  ${String(document.sizeBytes)}B  [${document.status}]`,
    ),
  );
  const confirmingDocument = confirmIndex === null ? undefined : documentsList[confirmIndex];

  return (
    <Box flexDirection="column">
      {documentsList.length === 0 ? (
        <Text>{props.theme.muted("No indexed documents for this persona.")}</Text>
      ) : (
        <SelectableList
          items={rows}
          isActive={(props.isActive ?? false) && confirmIndex === null}
          height={10}
          onActivate={(index) => {
            setRemoveError(undefined);
            setRemoveWarning(undefined);
            setConfirmIndex(index);
          }}
        />
      )}
      {confirmingDocument !== undefined ? (
        <Text>
          {props.theme.warn(toSingleLineDisplay(`Remove "${confirmingDocument.filename}"? [y/n]`))}
        </Text>
      ) : undefined}
      {removeError !== undefined ? <Text>{props.theme.error(removeError)}</Text> : undefined}
      {removeWarning !== undefined ? <Text>{props.theme.warn(removeWarning)}</Text> : undefined}
      {documentsList.length > 0 ? (
        <Text>{props.theme.muted("Enter remove · n cancel")}</Text>
      ) : undefined}
    </Box>
  );
}
