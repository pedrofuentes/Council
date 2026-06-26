// packages/cli/src/tui/screens/HomeScreen.tsx
import React from "react";
import { Box, Text, useInput } from "ink";
import { useNavigate } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { HomeData } from "../adapters/home-data.js";
import { useListSelection } from "../hooks/use-list-selection.js";
import { ROUTES } from "../router/routes.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface HomeScreenProps {
  readonly data: HomeData;
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

interface QuickAction {
  readonly kind: "quick";
  readonly key: string;
  readonly label: string;
  readonly route: string;
}

interface RecentItem {
  readonly kind: "recent";
  readonly id: string;
  readonly title: string;
  readonly when: string;
  readonly status: "convened" | "concluded";
}

type LaunchpadItem = QuickAction | RecentItem;

const QUICK_ACTIONS: readonly QuickAction[] = [
  { kind: "quick", key: "c", label: "▸ Convene a debate", route: ROUTES.panelCompose },
  { kind: "quick", key: "e", label: "New expert", route: ROUTES.expertNew },
  { kind: "quick", key: "p", label: "New panel", route: ROUTES.panelNew },
  { kind: "quick", key: ",", label: "Settings", route: ROUTES.settings },
];

function renderRow(item: LaunchpadItem, selected: boolean): string {
  const prefix = selected ? "› " : "  ";
  if (item.kind === "quick") {
    return `${prefix}${item.label}`;
  }
  const glyph = item.status === "concluded" ? "✓" : "•";
  return `${prefix}${glyph} ${toSingleLineDisplay(item.title)}  ${toSingleLineDisplay(item.when)}`;
}

export function HomeScreen(props: HomeScreenProps): React.ReactElement {
  const { counts, recent } = props.data;
  const navigate = useNavigate();
  const isActive = props.isActive ?? false;

  const empty = counts.sessions === 0 && counts.experts === 0 && counts.panels === 0;

  const items: readonly LaunchpadItem[] = empty
    ? QUICK_ACTIONS
    : [
        ...QUICK_ACTIONS,
        ...recent.map(
          (r): RecentItem => ({
            kind: "recent",
            id: r.id,
            title: r.title,
            when: r.when,
            status: r.status,
          }),
        ),
      ];

  const activate = (index: number): void => {
    const item = items[index];
    if (item === undefined) return;
    if (item.kind === "quick") {
      navigate(item.route);
    } else {
      navigate(`/sessions/${encodeURIComponent(item.id)}`);
    }
  };

  const { cursor } = useListSelection({
    count: items.length,
    isActive,
    onActivate: activate,
  });

  useInput(
    (input) => {
      if (input === "c") navigate(ROUTES.panelCompose);
      else if (input === "e") navigate(ROUTES.expertNew);
      else if (input === "p") navigate(ROUTES.panelNew);
      else if (input === ",") navigate(ROUTES.settings);
    },
    { isActive },
  );

  if (empty) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Text>
            {props.theme.muted("Council assembles experts into panels for deliberation.")}
          </Text>
        </Box>
        {items.map((item, index) => (
          <Text key={item.kind === "quick" ? item.route : item.id}>
            {renderRow(item, cursor === index)}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>{props.theme.muted("Quick actions")}</Text>
      {QUICK_ACTIONS.map((action, index) => (
        <Text key={action.route}>{renderRow(action, cursor === index)}</Text>
      ))}
      <Box marginTop={1}>
        <Text>{props.theme.muted("Recent sessions")}</Text>
      </Box>
      {recent.map((s, index) => {
        const item: RecentItem = {
          kind: "recent",
          id: s.id,
          title: s.title,
          when: s.when,
          status: s.status,
        };
        const itemIndex = QUICK_ACTIONS.length + index;
        return <Text key={s.id}>{renderRow(item, cursor === itemIndex)}</Text>;
      })}
      <Box marginTop={1}>
        <Text>
          {props.theme.muted(
            `${counts.sessions} sessions · ${counts.experts} experts · ${counts.panels} panels`,
          )}
        </Text>
      </Box>
    </Box>
  );
}
