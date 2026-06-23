import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useNavigate } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { ExpertsDataSource } from "../adapters/experts-data.js";
import { type PanelAuthoringDataSource, validatePanelName } from "../adapters/panel-authoring.js";
import { useData } from "../components/DataProvider.js";
import { useInputCapture } from "../components/InputCaptureProvider.js";
import { MultiSelectList } from "../components/lists/MultiSelectList.js";
import { useAsyncResource } from "../hooks/use-async-resource.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface PanelCreateScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

type Field = "name" | "members";

export function PanelCreateScreen(props: PanelCreateScreenProps): React.ReactElement {
  const data = useData();
  const panelAuthoring = data.panelAuthoring as PanelAuthoringDataSource | undefined;
  const experts = data.experts as ExpertsDataSource | undefined;
  const navigate = useNavigate();
  const { setCaptured } = useInputCapture();
  const [field, setField] = React.useState<Field>("name");
  const [name, setName] = React.useState("");
  const [selected, setSelected] = React.useState<readonly string[]>([]);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const inFlight = React.useRef(false);
  const isActive = props.isActive ?? true;

  React.useEffect(() => {
    setCaptured(true);
    return () => {
      setCaptured(false);
    };
  }, [setCaptured]);

  const loadExperts = React.useCallback(
    async () => (experts === undefined ? [] : experts.loadList()),
    [experts],
  );
  const expertState = useAsyncResource(loadExperts);

  const submit = React.useCallback(async (): Promise<void> => {
    if (expertState.status !== "loaded" || inFlight.current) {
      return;
    }
    if (panelAuthoring === undefined) {
      setError("Panel creation unavailable");
      return;
    }

    try {
      validatePanelName(name);
    } catch (err) {
      setError(toSingleLineDisplay(err instanceof Error ? err.message : String(err)));
      return;
    }

    if (selected.length === 0) {
      setError("Select at least one expert");
      return;
    }

    inFlight.current = true;
    setError(undefined);
    try {
      await panelAuthoring.create({ name, description: null, expertSlugs: selected });
      navigate(`/panels/${encodeURIComponent(name)}`, { state: { source: "saved" } });
    } catch (err) {
      inFlight.current = false;
      setError(toSingleLineDisplay(err instanceof Error ? err.message : String(err)));
    }
  }, [expertState.status, name, navigate, panelAuthoring, selected]);

  useInput(
    (_input, key) => {
      if (key.escape) {
        navigate(-1);
        return;
      }
      if (key.tab) {
        setField((current) => (current === "name" ? "members" : "name"));
      }
    },
    { isActive },
  );

  if (panelAuthoring === undefined || experts === undefined) {
    return <Text>{props.theme.error(toSingleLineDisplay("Panel creation unavailable"))}</Text>;
  }

  if (expertState.status === "loading") {
    return <Text>{props.theme.muted(toSingleLineDisplay("Loading experts…"))}</Text>;
  }

  if (expertState.status === "error") {
    return (
      <Text>
        {props.theme.error(
          toSingleLineDisplay(`Failed to load experts: ${expertState.error.message}`),
        )}
      </Text>
    );
  }

  const items = expertState.data.map((expert) => ({
    value: expert.slug,
    label: `${expert.displayName} — ${expert.role} [${expert.kind}]`,
  }));

  return (
    <Box flexDirection="column">
      <Box>
        <Text inverse={field === "name"}>{toSingleLineDisplay("Name: ")}</Text>
        <TextInput
          focus={isActive && field === "name"}
          onChange={(value) => {
            setName(value);
            setError(undefined);
          }}
          onSubmit={() => {
            setField("members");
          }}
          showCursor={field === "name"}
          value={toSingleLineDisplay(name)}
        />
      </Box>
      <Text inverse={field === "members"}>{toSingleLineDisplay("Members:")}</Text>
      <MultiSelectList
        items={items}
        selected={selected}
        isActive={isActive && field === "members"}
        height={Math.min(8, Math.max(1, items.length))}
        onChange={(next) => {
          setSelected(next);
          setError(undefined);
        }}
        onSubmit={() => {
          void submit();
        }}
      />
      {error !== undefined ? <Text>{props.theme.error(toSingleLineDisplay(error))}</Text> : null}
      <Text>{props.theme.muted("Tab focus · Space select · Enter create")}</Text>
    </Box>
  );
}
