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

interface RouteShortcuts {
  readonly pattern: string;
  readonly bindings: readonly ShortcutBinding[];
}

/**
 * Per-route key legends powering the contextual `?` help overlay. Entries are
 * ordered most-specific-first so a static path (e.g. `/panels/new`) resolves
 * ahead of its sibling parameterised route (`/panels/:name`); this mirrors the
 * declaration order in {@link ROUTES}. List screens that rely solely on the
 * global navigation (sessions, chats) are intentionally absent and resolve to
 * an empty legend.
 */
const ROUTE_SHORTCUTS: readonly RouteShortcuts[] = [
  {
    pattern: ROUTES.home,
    bindings: [
      { keys: "c", description: "Convene" },
      { keys: "e", description: "New expert" },
      { keys: "p", description: "New panel" },
      { keys: ",", description: "Settings" },
    ],
  },
  {
    pattern: ROUTES.onboarding,
    bindings: [
      { keys: "↑↓", description: "Move" },
      { keys: "Enter", description: "Confirm" },
      { keys: "Esc", description: "Skip" },
    ],
  },
  {
    pattern: ROUTES.panels,
    bindings: [
      { keys: "n", description: "New panel" },
      { keys: "c", description: "Auto-compose" },
    ],
  },
  {
    pattern: ROUTES.panelNew,
    bindings: [
      { keys: "Tab", description: "Focus" },
      { keys: "Space", description: "Select" },
      { keys: "Enter", description: "Create" },
    ],
  },
  {
    pattern: ROUTES.panelCompose,
    bindings: [
      { keys: "y", description: "Save" },
      { keys: "n/e", description: "Edit" },
      { keys: "Esc", description: "Cancel" },
    ],
  },
  {
    pattern: ROUTES.panelMembers,
    bindings: [
      { keys: "Space", description: "Select" },
      { keys: "Enter", description: "Save" },
      { keys: "Esc", description: "Back" },
    ],
  },
  {
    pattern: ROUTES.panelDelete,
    bindings: [
      { keys: "y", description: "Delete" },
      { keys: "n/Esc", description: "Cancel" },
    ],
  },
  {
    pattern: ROUTES.panelDetail,
    bindings: [
      { keys: "c", description: "Chat" },
      { keys: "m", description: "Edit members" },
      { keys: "d", description: "Delete" },
      { keys: "v", description: "Convene" },
    ],
  },
  {
    pattern: ROUTES.convenePrompt,
    bindings: [
      { keys: "Enter", description: "Estimate" },
      { keys: "Esc", description: "Cancel" },
    ],
  },
  {
    pattern: ROUTES.debateRun,
    bindings: [{ keys: "Esc", description: "Cancel" }],
  },
  {
    pattern: ROUTES.experts,
    bindings: [{ keys: "n", description: "New expert" }],
  },
  {
    pattern: ROUTES.expertNew,
    bindings: [
      { keys: "↑↓", description: "Move" },
      { keys: "Enter", description: "Edit" },
      { keys: "Ctrl+S", description: "Save" },
      { keys: "Esc", description: "Back" },
    ],
  },
  {
    pattern: ROUTES.expertEdit,
    bindings: [
      { keys: "↑↓", description: "Move" },
      { keys: "Enter", description: "Edit" },
      { keys: "Ctrl+S", description: "Save" },
      { keys: "Esc", description: "Back" },
    ],
  },
  {
    pattern: ROUTES.expertDelete,
    bindings: [
      { keys: "y", description: "Delete" },
      { keys: "n/Esc", description: "Cancel" },
    ],
  },
  {
    pattern: ROUTES.expertDocs,
    bindings: [
      { keys: "Enter", description: "Remove" },
      { keys: "n", description: "Cancel" },
    ],
  },
  {
    pattern: ROUTES.expertTrain,
    bindings: [
      { keys: "Enter", description: "Train" },
      { keys: "Esc", description: "Back" },
    ],
  },
  {
    pattern: ROUTES.expertDetail,
    bindings: [
      { keys: "e", description: "Edit" },
      { keys: "d", description: "Delete" },
      { keys: "o", description: "Documents" },
      { keys: "t", description: "Train" },
    ],
  },
  {
    pattern: ROUTES.sessionDetail,
    bindings: [
      { keys: "c", description: "Conclude" },
      { keys: "x", description: "Export" },
    ],
  },
  {
    pattern: ROUTES.sessionConclude,
    bindings: [{ keys: "Esc", description: "Back" }],
  },
  {
    pattern: ROUTES.sessionExport,
    bindings: [
      { keys: "j/k", description: "Move" },
      { keys: "Enter", description: "Select" },
      { keys: "Esc", description: "Back" },
    ],
  },
  {
    pattern: ROUTES.chatExpert,
    bindings: [
      { keys: "Enter", description: "Send" },
      { keys: "Esc", description: "Back" },
    ],
  },
  {
    pattern: ROUTES.chatPanel,
    bindings: [
      { keys: "Enter", description: "Send" },
      { keys: "Esc", description: "Back" },
    ],
  },
  {
    pattern: ROUTES.settings,
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
export function shortcutsForRoute(pathname: string): readonly ShortcutBinding[] {
  for (const entry of ROUTE_SHORTCUTS) {
    if (matchPath(entry.pattern, pathname) !== null) {
      return entry.bindings;
    }
  }
  return NO_SHORTCUTS;
}
