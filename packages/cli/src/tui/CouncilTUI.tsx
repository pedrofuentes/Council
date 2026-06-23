import React, { useState } from "react";
import { useApp, useInput, useStdout } from "ink";
import { MemoryRouter, Route, Routes } from "react-router";

import type { HomeData } from "./adapters/home-data.js";
import { AppShell } from "./components/layout/AppShell.js";
import { Footer } from "./components/layout/Footer.js";
import { Header } from "./components/layout/Header.js";
import { LeftNav } from "./components/navigation/LeftNav.js";
import { HelpModal } from "./components/overlays/HelpModal.js";
import { computeLayout, type NavState } from "./lib/breakpoints.js";
import { ROUTES } from "./router/routes.js";
import { HomeScreen } from "./screens/HomeScreen.js";
import { resolveTheme } from "./theme/tokens.js";

export interface CouncilTUIProps {
  readonly homeData: HomeData;
  readonly model: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly initialColumns?: number;
  readonly initialRows?: number;
}

type FocusMode = "nav" | "help";

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

export function CouncilTUI(props: CouncilTUIProps): React.ReactElement {
  const theme = resolveTheme(props.env ?? process.env);
  const { stdout } = useStdout();
  const app = useApp();

  const actualColumns = props.initialColumns ?? (stdout?.columns ?? 80);
  const actualRows = props.initialRows ?? (stdout?.rows ?? 24);

  const [navOverride, setNavOverride] = useState<NavState | undefined>(undefined);
  const [mode, setMode] = useState<FocusMode>("nav");
  const [activeRoute] = useState<string>("home");

  const layout = computeLayout({ columns: actualColumns, rows: actualRows, navOverride });

  useInput((input, key) => {
    if (input === "\\") {
      setNavOverride((current) => {
        const currentNav = current ?? layout.navState;
        return currentNav === "hidden" ? "expanded" : "hidden";
      });
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
      app.exit();
      return;
    }
    if (input === "q") {
      app.exit();
    }
  });

  const header = <Header breadcrumb="Council" model={props.model} compact={layout.compactHeader} theme={theme} />;

  const footer = (
    <Footer
      hints={[
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
        activeId={activeRoute}
        state={layout.navState}
        onSelect={() => {
          /* route handling placeholder */
        }}
        isActive={mode === "nav"}
        theme={theme}
      />
    ) : undefined;

  return (
    <MemoryRouter initialEntries={[ROUTES.home]}>
      <AppShell layout={layout} header={header} footer={footer} nav={nav}>
        {mode === "help" ? (
          <HelpModal entries={HELP_ENTRIES} onClose={() => setMode("nav")} isActive={mode === "help"} theme={theme} />
        ) : (
          <Routes>
            <Route path={ROUTES.home} element={<HomeScreen data={props.homeData} theme={theme} />} />
          </Routes>
        )}
      </AppShell>
    </MemoryRouter>
  );
}
