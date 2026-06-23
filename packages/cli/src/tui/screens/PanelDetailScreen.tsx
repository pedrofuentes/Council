import React from "react";
import { Box, Text, useInput } from "ink";
import { useLocation, useNavigate, useParams } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import { useData } from "../components/DataProvider.js";
import { useAsyncResource } from "../hooks/use-async-resource.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface PanelDetailScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

interface PanelLocationState {
  readonly source?: "saved" | "template";
}

function formatDefaults(defaults: {
  readonly mode?: string;
  readonly maxRounds?: number;
  readonly model?: string;
}): string {
  const parts: string[] = [];
  if (defaults.mode !== undefined) parts.push(defaults.mode);
  if (defaults.maxRounds !== undefined) parts.push(`${String(defaults.maxRounds)} rounds`);
  if (defaults.model !== undefined) parts.push(defaults.model);
  return toSingleLineDisplay(parts.join(" · "));
}

export function PanelDetailScreen(props: PanelDetailScreenProps): React.ReactElement {
  const { name } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const source = (location.state as PanelLocationState | null)?.source ?? "saved";
  const { panels } = useData();
  const loader = React.useCallback(
    () => panels.loadDetail(name ?? "", source),
    [panels, name, source],
  );
  const state = useAsyncResource(loader);

  useInput(
    (input) => {
      if (input === "m" && source === "saved" && name !== undefined) {
        navigate(`/panels/${encodeURIComponent(name)}/members`, { state: { source: "saved" } });
      }
      if (input === "d" && source === "saved" && name !== undefined) {
        navigate(`/panels/${encodeURIComponent(name)}/delete`, { state: { source: "saved" } });
      }
      if (input === "v" && source === "saved" && name !== undefined) {
        navigate(`/convene/${encodeURIComponent(name)}`, { state: { source: "saved" } });
      }
    },
    { isActive: props.isActive ?? true },
  );

  if (state.status === "loading") {
    return <Text>{props.theme.muted("Loading panel…")}</Text>;
  }

  if (state.status === "error") {
    return <Text>{props.theme.error("Failed to load panel")}</Text>;
  }

  if (state.data === undefined) {
    return <Text>{props.theme.warn("Panel not found")}</Text>;
  }

  const detail = state.data;
  return (
    <Box flexDirection="column">
      <Text>{props.theme.accent(toSingleLineDisplay(detail.name))}</Text>
      {detail.description !== "" ? (
        <Text>{toSingleLineDisplay(detail.description)}</Text>
      ) : undefined}
      {detail.defaults !== undefined ? <Text>{formatDefaults(detail.defaults)}</Text> : undefined}
      <Text>{props.theme.accent("Members")}</Text>
      {detail.members.map((member) => (
        <Text key={member.slug}>
          {toSingleLineDisplay(
            `  ${member.slug} — ${member.displayName} · ${member.role} [${member.kind}]`,
          )}
        </Text>
      ))}
      {detail.missing.map((slug) => (
        <Text key={slug}>{props.theme.warn(toSingleLineDisplay(`⚠ ${slug} (missing)`))}</Text>
      ))}
      {source === "saved" ? (
        <Text>
          {props.theme.muted(toSingleLineDisplay("m edit members · d delete · v convene"))}
        </Text>
      ) : undefined}
    </Box>
  );
}
