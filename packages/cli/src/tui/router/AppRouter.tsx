import React, { useState } from "react";
import { useApp, useInput, useStdout } from "ink";
import { Route, Routes, useLocation, useNavigate } from "react-router";

import type { HomeData } from "../adapters/home-data.js";
import { AppShell } from "../components/layout/AppShell.js";
import { Footer } from "../components/layout/Footer.js";
import { Header } from "../components/layout/Header.js";
import { LeftNav } from "../components/navigation/LeftNav.js";
import { HelpModal } from "../components/overlays/HelpModal.js";
import { computeLayout, type NavState } from "../lib/breakpoints.js";
import { ExpertDetailScreen } from "../screens/ExpertDetailScreen.js";
import { ExpertsScreen } from "../screens/ExpertsScreen.js";
import { HomeScreen } from "../screens/HomeScreen.js";
import { PanelDetailScreen } from "../screens/PanelDetailScreen.js";
import { PanelsScreen } from "../screens/PanelsScreen.js";
import { PlaceholderScreen } from "../screens/PlaceholderScreen.js";
import { resolveTheme } from "../theme/tokens.js";
import { routeToNavId, ROUTES } from "./routes.js";

export interface CouncilTUIProps {
  readonly homeData: HomeData;
  readonly model: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly initialColumns?: number;
  readonly initialRows?: number;
}

type FocusMode = "nav" | "help";
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
  const navId = routeToNavId(location.pathname);

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

  useInput((input, key) => {
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
  });

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
      {mode === "help" ? (
        <HelpModal
          entries={HELP_ENTRIES}
          onClose={() => setMode("nav")}
          isActive={mode === "help"}
          theme={theme}
        />
      ) : (
        <Routes>
          <Route path={ROUTES.home} element={<HomeScreen data={props.homeData} theme={theme} />} />
          <Route
            path={ROUTES.panels}
            element={<PanelsScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.panelDetail}
            element={<PanelDetailScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.experts}
            element={<ExpertsScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.expertDetail}
            element={<ExpertDetailScreen theme={theme} isActive={mainActive} />}
          />
          <Route
            path={ROUTES.sessions}
            element={<PlaceholderScreen title="Sessions" theme={theme} />}
          />
          <Route path={ROUTES.chats} element={<PlaceholderScreen title="Chats" theme={theme} />} />
          <Route
            path={ROUTES.settings}
            element={<PlaceholderScreen title="Settings" theme={theme} />}
          />
        </Routes>
      )}
    </AppShell>
  );
}
