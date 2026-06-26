import React from "react";
import { Box, Text, useInput } from "ink";
import { useLocation, useNavigate, useParams } from "react-router";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type {
  SessionsDataSource,
  SessionTranscriptView,
  TranscriptLine,
} from "../adapters/sessions-data.js";
import { useData } from "../components/DataProvider.js";
import { useInputCapture } from "../components/InputCaptureProvider.js";
import { ActionMenu, type ActionMenuItem } from "../components/overlays/ActionMenu.js";
import { ScrollView } from "../components/lists/ScrollView.js";
import { useAsyncResource } from "../hooks/use-async-resource.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface SessionDetailScreenProps {
  readonly theme: SemanticTheme;
  readonly isActive?: boolean;
}

function formatLine(line: TranscriptLine): string {
  const speaker = toSingleLineDisplay(line.speaker);
  const content = toSingleLineDisplay(line.content);
  return toSingleLineDisplay(`[r${String(line.round)}] ${speaker}: ${content}`);
}

function renderDetail(detail: SessionTranscriptView, theme: SemanticTheme): React.ReactElement {
  const rows = detail.lines.map(formatLine);

  return (
    <Box flexDirection="column">
      <Text>{theme.accent(toSingleLineDisplay(detail.panelName))}</Text>
      {detail.topic !== "" ? <Text>{toSingleLineDisplay(detail.topic)}</Text> : undefined}
      <Text>{theme.muted(toSingleLineDisplay(`Prompt: ${detail.prompt}`))}</Text>
      <Text>{theme.muted(toSingleLineDisplay(`Status: ${detail.status}`))}</Text>
      {rows.length === 0 ? (
        <Text>{theme.muted("No turns yet")}</Text>
      ) : (
        <ScrollView items={rows} height={12} />
      )}
      <Text>{theme.muted(toSingleLineDisplay("c conclude · x export"))}</Text>
    </Box>
  );
}

const SESSION_MENU_ITEMS: readonly ActionMenuItem[] = [
  { key: "c", label: "Conclude" },
  { key: "x", label: "Export" },
];

export function SessionDetailScreen(props: SessionDetailScreenProps): React.ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const { id } = useParams();
  const panelName = (location.state as { panelName?: string } | null)?.panelName;
  const data = useData();
  const sessions = data.sessions as SessionsDataSource | undefined;
  const loader = React.useCallback(
    () =>
      sessions !== undefined && panelName !== undefined
        ? sessions.loadTranscript(panelName)
        : Promise.resolve<SessionTranscriptView | undefined>(undefined),
    [sessions, panelName],
  );
  const state = useAsyncResource(loader);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const { setCaptured } = useInputCapture();

  React.useEffect(() => {
    if (!menuOpen) return undefined;
    setCaptured(true);
    return () => {
      setCaptured(false);
    };
  }, [menuOpen, setCaptured]);

  const handleAction = (key: string): void => {
    if (key === "c" && id !== undefined && panelName !== undefined) {
      navigate(`/sessions/${encodeURIComponent(id)}/conclude`, { state: { panelName } });
    }
    if (key === "x" && id !== undefined && panelName !== undefined) {
      navigate(`/sessions/${encodeURIComponent(id)}/export`, { state: { panelName } });
    }
  };

  useInput(
    (input) => {
      if (input === "a") {
        setMenuOpen(true);
        return;
      }
      handleAction(input);
    },
    { isActive: (props.isActive ?? false) && !menuOpen },
  );

  if (menuOpen) {
    return (
      <ActionMenu
        items={SESSION_MENU_ITEMS}
        isActive
        onSelect={(key) => {
          setMenuOpen(false);
          handleAction(key);
        }}
        onClose={() => {
          setMenuOpen(false);
        }}
        theme={props.theme}
      />
    );
  }

  if (state.status === "loading") {
    return <Text>{props.theme.muted("Loading session…")}</Text>;
  }

  if (state.status === "error") {
    return <Text>{props.theme.error("Failed to load session")}</Text>;
  }

  if (state.data === undefined) {
    return <Text>{props.theme.warn("No transcript available")}</Text>;
  }

  return renderDetail(state.data, props.theme);
}
