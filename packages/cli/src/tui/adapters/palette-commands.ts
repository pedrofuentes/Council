import { routeToNavId, ROUTES } from "../router/routes.js";

export interface PaletteAction {
  readonly id: string;
  readonly label: string;
  readonly route?: string;
  readonly kind: "navigate" | "help" | "quit";
}

export interface PaletteContext {
  readonly navId: string;
}

interface NavigatePaletteAction extends PaletteAction {
  readonly route: string;
  readonly kind: "navigate";
}

const NAVIGATE_ACTIONS: readonly NavigatePaletteAction[] = [
  { id: "go-home", label: "Go to Home", route: ROUTES.home, kind: "navigate" },
  { id: "go-panels", label: "Go to Panels", route: ROUTES.panels, kind: "navigate" },
  { id: "go-experts", label: "Go to Experts", route: ROUTES.experts, kind: "navigate" },
  { id: "go-sessions", label: "Go to Sessions", route: ROUTES.sessions, kind: "navigate" },
  { id: "go-settings", label: "Go to Settings", route: ROUTES.settings, kind: "navigate" },
];

const GLOBAL_ACTIONS: readonly PaletteAction[] = [
  { id: "help", label: "Help", kind: "help" },
  { id: "quit", label: "Quit", kind: "quit" },
];

export function buildPaletteCommands(ctx: PaletteContext): readonly PaletteAction[] {
  return [
    ...NAVIGATE_ACTIONS.filter((action) => routeToNavId(action.route) !== ctx.navId),
    ...GLOBAL_ACTIONS,
  ];
}
