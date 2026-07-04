import { matchPath } from "react-router";

import { ROUTES } from "../router/routes.js";

/**
 * A single key legend entry: the literal key(s) a user presses and the action
 * they trigger on the current screen. Labels are static and trusted, so they
 * require no sanitization at the `<Text>` sink that renders them.
 */
export interface ShortcutBinding {
  readonly keys: string;
  readonly description: string;
}

export interface RouteShortcuts {
  readonly pattern: string;
  /**
   * Screen module (relative to `tui/screens/`) whose `useInput` handler owns
   * these bindings. This ties the advertised legend to the code that actually
   * dispatches the keys; the `shortcuts-drift` test uses it to fail the build
   * if a single-key command drifts away from its handler (#1703). Keep in
   * lockstep with the route→component wiring in {@link AppRouter}.
   */
  readonly screen: string;
  readonly bindings: readonly ShortcutBinding[];
}

export interface ShortcutContext {
  readonly panelSource?: "saved" | "template";
}

/**
 * Per-route key legends powering the contextual `?` help overlay. Entries are
 * ordered most-specific-first so a static path (e.g. `/panels/new`) resolves
 * ahead of its sibling parameterised route (`/panels/:name`); this mirrors the
 * declaration order in {@link ROUTES}. List screens that rely solely on the
 * global navigation (sessions, chats) are intentionally absent and resolve to
 * an empty legend.
 *
 * Exported so the `shortcuts-drift` test can cross-check each entry's advertised
 * single-key commands against the `screen` that dispatches them, preventing the
 * legend from drifting away from the actual handlers (#1703).
 */
export const ROUTE_SHORTCUTS: readonly RouteShortcuts[] = [
  {
    pattern: ROUTES.home,
    screen: "HomeScreen.tsx",
    bindings: [
      { keys: "c", description: "Convene" },
      { keys: "e", description: "New expert" },
      { keys: "p", description: "New panel" },
      { keys: ",", description: "Settings" },
    ],
  },
  {
    pattern: ROUTES.onboarding,
    screen: "OnboardingScreen.tsx",
    bindings: [
      { keys: "↑↓", description: "Move" },
      { keys: "Enter", description: "Confirm" },
      { keys: "Esc", description: "Skip" },
    ],
  },
  {
    pattern: ROUTES.panels,
    screen: "PanelsScreen.tsx",
    bindings: [
      { keys: "n", description: "New panel" },
      { keys: "c", description: "Auto-compose" },
    ],
  },
  {
    pattern: ROUTES.panelNew,
    screen: "PanelCreateScreen.tsx",
    bindings: [
      { keys: "Tab", description: "Focus" },
      { keys: "Space", description: "Select" },
      { keys: "Enter", description: "Create" },
    ],
  },
  {
    pattern: ROUTES.panelCompose,
    screen: "PanelComposeScreen.tsx",
    bindings: [
      { keys: "y", description: "Save" },
      { keys: "n/e", description: "Revise" },
      { keys: "Esc", description: "Cancel" },
    ],
  },
  {
    pattern: ROUTES.panelMembers,
    screen: "PanelMembersScreen.tsx",
    bindings: [
      { keys: "Space", description: "Select" },
      { keys: "Enter", description: "Save" },
      { keys: "Esc", description: "Back" },
    ],
  },
  {
    pattern: ROUTES.panelDelete,
    screen: "PanelDeleteScreen.tsx",
    bindings: [
      { keys: "y", description: "Delete" },
      { keys: "n/Esc", description: "Cancel" },
    ],
  },
  {
    pattern: ROUTES.panelDetail,
    screen: "PanelDetailScreen.tsx",
    bindings: [
      { keys: "c", description: "Chat" },
      { keys: "m", description: "Edit members" },
      { keys: "d", description: "Delete" },
      { keys: "v", description: "Convene" },
      { keys: "a", description: "Actions" },
    ],
  },
  {
    pattern: ROUTES.convenePrompt,
    screen: "ConvenePromptScreen.tsx",
    bindings: [
      { keys: "Enter", description: "Estimate" },
      { keys: "Esc", description: "Cancel" },
    ],
  },
  {
    pattern: ROUTES.debateRun,
    screen: "DebateStreamScreen.tsx",
    bindings: [{ keys: "Esc", description: "Cancel" }],
  },
  {
    pattern: ROUTES.experts,
    screen: "ExpertsScreen.tsx",
    bindings: [{ keys: "n", description: "New expert" }],
  },
  {
    pattern: ROUTES.expertNew,
    screen: "ExpertFormScreen.tsx",
    bindings: [
      { keys: "↑↓", description: "Move" },
      { keys: "Enter", description: "Edit" },
      { keys: "Ctrl+S", description: "Save" },
      { keys: "Esc", description: "Back" },
    ],
  },
  {
    pattern: ROUTES.expertEdit,
    screen: "ExpertFormScreen.tsx",
    bindings: [
      { keys: "↑↓", description: "Move" },
      { keys: "Enter", description: "Edit" },
      { keys: "Ctrl+S", description: "Save" },
      { keys: "Esc", description: "Back" },
    ],
  },
  {
    pattern: ROUTES.expertDelete,
    screen: "ExpertDeleteScreen.tsx",
    bindings: [
      { keys: "y", description: "Delete" },
      { keys: "n/Esc", description: "Cancel" },
    ],
  },
  {
    pattern: ROUTES.expertDocs,
    screen: "ExpertDocumentsScreen.tsx",
    bindings: [
      { keys: "Enter", description: "Remove" },
      { keys: "n", description: "Cancel" },
    ],
  },
  {
    pattern: ROUTES.expertTrain,
    screen: "ExpertTrainScreen.tsx",
    bindings: [
      { keys: "Enter", description: "Train" },
      { keys: "Esc", description: "Back" },
    ],
  },
  {
    pattern: ROUTES.expertDetail,
    screen: "ExpertDetailScreen.tsx",
    bindings: [
      { keys: "c", description: "Chat" },
      { keys: "e", description: "Edit" },
      { keys: "d", description: "Delete" },
      { keys: "o", description: "Documents" },
      { keys: "t", description: "Train" },
      { keys: "a", description: "Actions" },
    ],
  },
  {
    pattern: ROUTES.sessionDetail,
    screen: "SessionDetailScreen.tsx",
    bindings: [
      { keys: "c", description: "Conclude" },
      { keys: "x", description: "Export" },
      { keys: "a", description: "Actions" },
    ],
  },
  {
    pattern: ROUTES.sessionConclude,
    screen: "ConclusionScreen.tsx",
    bindings: [
      { keys: "x", description: "Export" },
      { keys: "r", description: "Re-convene" },
      { keys: "Esc", description: "Back" },
    ],
  },
  {
    pattern: ROUTES.sessionExport,
    screen: "ExportOverlay.tsx",
    bindings: [
      { keys: "↑↓", description: "Move" },
      { keys: "Enter", description: "Select" },
      { keys: "Esc", description: "Back" },
    ],
  },
  {
    pattern: ROUTES.chatExpert,
    screen: "ExpertChatScreen.tsx",
    bindings: [
      { keys: "Enter", description: "Send" },
      { keys: "Esc", description: "Back" },
    ],
  },
  {
    pattern: ROUTES.chatPanel,
    screen: "PanelChatScreen.tsx",
    bindings: [
      { keys: "Enter", description: "Send" },
      { keys: "Esc", description: "Back" },
    ],
  },
  {
    pattern: ROUTES.settings,
    screen: "SettingsScreen.tsx",
    bindings: [
      { keys: "↑↓", description: "Move" },
      { keys: "Enter", description: "Edit" },
      { keys: "Ctrl+S", description: "Save" },
      { keys: "Esc", description: "Back" },
    ],
  },
];

const NO_SHORTCUTS: readonly ShortcutBinding[] = [];

/**
 * Resolve the contextual key legend for a concrete pathname. Returns the first
 * matching route's bindings (most-specific-first), or an empty legend for
 * global-navigation-only list routes and unknown paths.
 */
export function shortcutsForRoute(
  pathname: string,
  context: ShortcutContext = {},
): readonly ShortcutBinding[] {
  for (const entry of ROUTE_SHORTCUTS) {
    if (matchPath(entry.pattern, pathname) !== null) {
      if (entry.pattern === ROUTES.panelDetail && context.panelSource === "template") {
        return entry.bindings.filter((binding) => binding.keys !== "a");
      }
      return entry.bindings;
    }
  }
  return NO_SHORTCUTS;
}
