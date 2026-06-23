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
        return;
      }
      if (input === "y" && document !== undefined && !removingRef.current) {
        removingRef.current = true;
        setRemoveError(undefined);
        void (async (): Promise<void> => {
          try {
            await documents?.remove(slugValue, document.id);
            setConfirmIndex(null);
            setReloadKey((key) => key + 1);
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

  if (state.data.length === 0) {
    return <Text>{props.theme.muted("No indexed documents for this persona.")}</Text>;
  }

  const rows = state.data.map((document) =>
    toSingleLineDisplay(
      `${document.filename}  ${String(document.sizeBytes)}B  [${document.status}]`,
    ),
  );
  const confirmingDocument = confirmIndex === null ? undefined : state.data[confirmIndex];

  return (
    <Box flexDirection="column">
      <SelectableList
        items={rows}
        isActive={(props.isActive ?? false) && confirmIndex === null}
        height={10}
        onActivate={(index) => {
          setRemoveError(undefined);
          setConfirmIndex(index);
        }}
      />
      {confirmingDocument !== undefined ? (
        <Text>
          {props.theme.warn(toSingleLineDisplay(`Remove "${confirmingDocument.filename}"? [y/n]`))}
        </Text>
      ) : undefined}
      {removeError !== undefined ? <Text>{props.theme.error(removeError)}</Text> : undefined}
      <Text>{props.theme.muted("Enter remove · n cancel")}</Text>
    </Box>
  );
}
