import React from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate, useParams } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { ExpertsDataSource, ExpertListItem } from "../adapters/experts-data.js";
import type { PanelAuthoringDataSource } from "../adapters/panel-authoring.js";
import type { PanelDetailView, PanelsDataSource } from "../adapters/panels-data.js";
import { useData } from "../components/DataProvider.js";
import { useInputCapture } from "../components/InputCaptureProvider.js";
import { MultiSelectList } from "../components/lists/MultiSelectList.js";
import { useAsyncResource } from "../hooks/use-async-resource.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface PanelMembersScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

interface PanelMembersResource {
  readonly detail: PanelDetailView | undefined;
  readonly currentMembers: readonly string[];
  readonly allExperts: readonly ExpertListItem[];
}

export function PanelMembersScreen(props: PanelMembersScreenProps): React.ReactElement {
  const { name } = useParams();
  const data = useData();
  const panelAuthoring = data.panelAuthoring as PanelAuthoringDataSource | undefined;
  const panels = data.panels as PanelsDataSource | undefined;
  const experts = data.experts as ExpertsDataSource | undefined;
  const navigate = useNavigate();
  const { setCaptured } = useInputCapture();
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

  const loader = React.useCallback(async (): Promise<PanelMembersResource> => {
    const panelName = name ?? "";
    const [detail, allExperts] = await Promise.all([
      panels?.loadDetail(panelName, "saved") ?? Promise.resolve(undefined),
      experts?.loadList() ?? Promise.resolve([]),
    ]);
    return {
      detail,
      currentMembers: detail?.members.map((member) => member.slug) ?? [],
      allExperts,
    };
  }, [experts, name, panels]);
  const resource = useAsyncResource(loader);

  React.useEffect(() => {
    if (resource.status === "loaded") {
      setSelected(resource.data.currentMembers);
    }
  }, [resource]);

  const submit = React.useCallback(async (): Promise<void> => {
    if (resource.status !== "loaded" || inFlight.current) {
      return;
    }
    if (panelAuthoring === undefined) {
      setError(toSingleLineDisplay("Panel member editing unavailable"));
      return;
    }
    if (selected.length === 0) {
      setError(toSingleLineDisplay("Select at least one expert"));
      return;
    }

    inFlight.current = true;
    setError(undefined);
    try {
      await panelAuthoring.setMembers(name ?? "", selected);
      navigate(`/panels/${encodeURIComponent(name ?? "")}`, { state: { source: "saved" } });
    } catch (err) {
      inFlight.current = false;
      setError(toSingleLineDisplay(err instanceof Error ? err.message : String(err)));
    }
  }, [name, navigate, panelAuthoring, resource.status, selected]);

  useInput(
    (_input, key) => {
      if (key.escape) {
        if (!inFlight.current) {
          navigate(-1);
        }
        return;
      }
    },
    { isActive },
  );

  if (panelAuthoring === undefined || panels === undefined || experts === undefined) {
    return (
      <Text>{props.theme.error(toSingleLineDisplay("Panel member editing unavailable"))}</Text>
    );
  }

  if (resource.status === "loading") {
    return <Text>{props.theme.muted(toSingleLineDisplay("Loading panel members…"))}</Text>;
  }

  if (resource.status === "error") {
    return (
      <Text>
        {props.theme.error(
          toSingleLineDisplay(`Failed to load panel members: ${resource.error.message}`),
        )}
      </Text>
    );
  }

  if (resource.data.detail === undefined) {
    return <Text>{props.theme.warn(toSingleLineDisplay("Panel not found"))}</Text>;
  }

  const items = resource.data.allExperts.map((expert) => ({
    value: expert.slug,
    label: `${expert.displayName} — ${expert.role} [${expert.kind}]`,
  }));

  return (
    <Box flexDirection="column">
      <Text>{props.theme.accent(toSingleLineDisplay(`Members: ${name ?? ""}`))}</Text>
      <MultiSelectList
        items={items}
        selected={selected}
        isActive={isActive}
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
      <Text>{props.theme.muted(toSingleLineDisplay("Space select · Enter save · Esc back"))}</Text>
    </Box>
  );
}
