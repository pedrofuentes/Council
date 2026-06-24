import React, { useState } from "react";
import { useApp, useInput, useStdout } from "ink";
import { Route, Routes, useLocation, useNavigate } from "react-router";

import type { HomeData } from "../adapters/home-data.js";
import { buildPaletteCommands, type PaletteAction } from "../adapters/palette-commands.js";
import { useInputCapture } from "../components/InputCaptureProvider.js";
import { AppShell } from "../components/layout/AppShell.js";
import { StartupBanner } from "../components/layout/StartupBanner.js";
import { Footer } from "../components/layout/Footer.js";
import { Header } from "../components/layout/Header.js";
import { LeftNav } from "../components/navigation/LeftNav.js";
import { CommandPalette } from "../components/overlays/CommandPalette.js";
import { HelpModal } from "../components/overlays/HelpModal.js";
import { computeLayout, type NavState } from "../lib/breakpoints.js";
import type { StartupWarning } from "../lib/startup-warnings.js";
import { ExpertDetailScreen } from "../screens/ExpertDetailScreen.js";
import { ExpertChatScreen } from "../screens/ExpertChatScreen.js";
import { PanelChatScreen } from "../screens/PanelChatScreen.js";
import { ExpertDeleteScreen } from "../screens/ExpertDeleteScreen.js";
import { ExpertDocumentsScreen } from "../screens/ExpertDocumentsScreen.js";
import { ExpertFormScreen } from "../screens/ExpertFormScreen.js";
import { ExpertTrainScreen } from "../screens/ExpertTrainScreen.js";
import { ExpertsScreen } from "../screens/ExpertsScreen.js";
import { HomeScreen } from "../screens/HomeScreen.js";
import { OnboardingScreen } from "../screens/OnboardingScreen.js";
import { ConvenePromptScreen } from "../screens/ConvenePromptScreen.js";
import { DebateStreamScreen } from "../screens/DebateStreamScreen.js";
import { PanelCreateScreen } from "../screens/PanelCreateScreen.js";
import { PanelComposeScreen } from "../screens/PanelComposeScreen.js";
import { PanelDeleteScreen } from "../screens/PanelDeleteScreen.js";
import { PanelDetailScreen } from "../screens/PanelDetailScreen.js";
import { PanelMembersScreen } from "../screens/PanelMembersScreen.js";
import { PanelsScreen } from "../screens/PanelsScreen.js";
import { SessionDetailScreen } from "../screens/SessionDetailScreen.js";
import { ConclusionScreen } from "../screens/ConclusionScreen.js";
import { ExportOverlay } from "../screens/ExportOverlay.js";
import { SettingsScreen } from "../screens/SettingsScreen.js";
import { SessionsScreen } from "../screens/SessionsScreen.js";
import { ChatsScreen } from "../screens/ChatsScreen.js";
import { resolveTheme } from "../theme/tokens.js";
import { routeToNavId, ROUTES } from "./routes.js";

export interface CouncilTUIProps {
  readonly homeData: HomeData;
  readonly model: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly initialColumns?: number;
  readonly initialRows?: number;
  readonly startupWarnings?: readonly StartupWarning[];
  readonly isFirstRun?: boolean;
}

type FocusMode = "nav" | "help" | "palette";
type FocusTarget = "nav" | "main";

const NAV_ITEMS = [
  { id: "home", label: "Home", glyph: "🏠" },
  { id: "panels", label: "Panels", glyph: "📋" },
  { id: "experts", label: "Experts", glyph: "👤" },
  { id: "sessions", label: "Sessions", glyph: "💬" },
  { id: "chats", label: "Chats", glyph: "📝" },
  { id: "settings", label: "Settings", glyph: "⚙" },
];

const HELP_ENTRIES = [
  { keys: "↑↓ j k", description: "Navigate" },
  { keys: "Enter", description: "Select" },
  { keys: "\\", description: "Toggle nav" },
  { keys: "?", description: "Help" },
  { keys: "q Esc", description: "Quit" },
];

const NAV_ID_TO_ROUTE: Record<string, string> = {
  home: ROUTES.home,
  panels: ROUTES.panels,
  experts: ROUTES.experts,
  sessions: ROUTES.sessions,
  chats: ROUTES.chats,
  settings: ROUTES.settings,
};

const NAV_LABEL: Record<string, string> = {
  home: "Council",
  panels: "Panels",
  experts: "Experts",
  sessions: "Sessions",
  chats: "Chats",
  settings: "Settings",
};

export function AppRouter(props: CouncilTUIProps): React.ReactElement {
  const theme = resolveTheme(props.env ?? process.env);
  const { stdout } = useStdout();
  const app = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const { captured } = useInputCapture();
  const navId = routeToNavId(location.pathname);
  const paletteCommands = buildPaletteCommands({ navId });

  const actualColumns = props.initialColumns ?? stdout?.columns ?? 80;
  const actualRows = props.initialRows ?? stdout?.rows ?? 24;

  const [navOverride, setNavOverride] = useState<NavState | undefined>(undefined);
  const [mode, setMode] = useState<FocusMode>("nav");
  const [focus, setFocus] = useState<FocusTarget>("main");

  const mainActive = mode === "nav" && focus === "main";

  const layout = computeLayout(
    navOverride !== undefined
      ? { columns: actualColumns, rows: actualRows, navOverride }
      : { columns: actualColumns, rows: actualRows },
  );

  useInput(
    (input, key) => {
      if (key.ctrl && input === "k") {
        setMode("palette");
        return;
      }
      if (input === "\\") {
        setNavOverride((current) => {
          const currentNav = current ?? layout.navState;
          return currentNav === "hidden" ? "expanded" : "hidden";
        });
        return;
      }
      if (key.tab) {
        if (mode === "nav") setFocus((f) => (f === "nav" ? "main" : "nav"));
        return;
      }
      if (input === "?") {
        setMode("help");
        return;
      }
      if (key.escape) {
        if (mode === "help") {
          setMode("nav");
          return;
        }
        if (location.pathname !== ROUTES.home) {
          navigate(-1);
          return;
        }
        app.exit();
        return;
      }
      if (input === "q") {
        app.exit();
      }
    },
    { isActive: mode !== "palette" && !captured },
  );

  const onPaletteSelect = (id: string): void => {
    const action: PaletteAction | undefined = paletteCommands.find((c) => c.id === id);
    if (action === undefined) return;
    if (action.kind === "navigate" && action.route !== undefined) {
      setMode("nav");
      navigate(action.route);
    } else if (action.kind === "help") {
      setMode("help");
    } else if (action.kind === "quit") {
      app.exit();
    }
  };

  const header = (
    <Header
      breadcrumb={NAV_LABEL[navId] ?? "Council"}
      model={props.model}
      compact={layout.compactHeader}
      theme={theme}
    />
  );

  const footer = (
    <Footer
      hints={[
        { key: "Tab", label: "Focus" },
        { key: "↑↓", label: "Nav" },
        { key: "Enter", label: "Select" },
        { key: "\\", label: "Toggle" },
        { key: "^K", label: "Palette" },
        { key: "?", label: "Help" },
        { key: "q", label: "Quit" },
      ]}
      mode="NAV"
      showLabels={layout.footerLabels}
      theme={theme}
    />
  );

  const nav =
    layout.navState !== "hidden" ? (
      <LeftNav
        items={NAV_ITEMS}
        activeId={navId}
        state={layout.navState}
        onSelect={(id) => {
          setFocus("main");
          navigate(NAV_ID_TO_ROUTE[id] ?? ROUTES.home);
        }}
        isActive={mode === "nav" && focus === "nav"}
        theme={theme}
      />
    ) : undefined;

  return (
    <AppShell layout={layout} header={header} footer={footer} nav={nav}>
      <StartupBanner warnings={props.startupWarnings ?? []} theme={theme} />
      {mode === "help" ? (
        <HelpModal
          entries={HELP_ENTRIES}
          onClose={() => setMode("nav")}
          isActive={mode === "help"}
          theme={theme}
        />
      ) : mode === "palette" ? (
        <CommandPalette
          commands={paletteCommands.map((c) => ({ id: c.id, label: c.label }))}
          onSelect={onPaletteSelect}
          onClose={() => setMode("nav")}
          isActive={mode === "palette"}
        />
      ) : (
        <Routes>
          <Route path={ROUTES.home} element={<HomeScreen data={props.homeData} theme={theme} />} />
          <Route
            path={ROUTES.onboarding}
            element={<OnboardingScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.panels}
            element={<PanelsScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.panelNew}
            element={<PanelCreateScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.panelCompose}
            element={<PanelComposeScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.panelMembers}
            element={<PanelMembersScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.panelDelete}
            element={<PanelDeleteScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.panelDetail}
            element={<PanelDetailScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.convenePrompt}
            element={<ConvenePromptScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.debateRun}
            element={<DebateStreamScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.experts}
            element={<ExpertsScreen theme={theme} isActive={mainActive} />}
          />
          <Route path={ROUTES.expertNew} element={<ExpertFormScreen theme={theme} />} />
          <Route
            path={ROUTES.expertEdit}
            element={<ExpertFormScreen formMode="edit" theme={theme} />}
          />
          <Route path={ROUTES.expertDelete} element={<ExpertDeleteScreen theme={theme} />} />
          <Route
            path={ROUTES.expertDocs}
            element={<ExpertDocumentsScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.expertTrain}
            element={<ExpertTrainScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.expertDetail}
            element={<ExpertDetailScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.sessions}
            element={<SessionsScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.sessionDetail}
            element={<SessionDetailScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.sessionConclude}
            element={<ConclusionScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.sessionExport}
            element={<ExportOverlay theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.chats}
            element={<ChatsScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.chatExpert}
            element={<ExpertChatScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.chatPanel}
            element={<PanelChatScreen theme={theme} isActive={mainActive} />}
          />
          <Route path={ROUTES.settings} element={<SettingsScreen theme={theme} />} />
        </Routes>
      )}
    </AppShell>
  );
}
