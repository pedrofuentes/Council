// packages/cli/src/tui/hooks/use-mode.ts
import { useReducer } from "react";

export type Mode = "nav" | "typing" | "palette";

export type ModeAction =
  | { readonly type: "enterTyping" }
  | { readonly type: "exitTyping" }
  | { readonly type: "openPalette" }
  | { readonly type: "closePalette" };

export function modeReducer(state: Mode, action: ModeAction): Mode {
  switch (action.type) {
    case "enterTyping":
      return "typing";
    case "exitTyping":
      return state === "typing" ? "nav" : state;
    case "openPalette":
      return "palette";
    case "closePalette":
      return "nav";
    default:
      return state;
  }
}

export interface UseModeResult {
  readonly mode: Mode;
  readonly dispatch: (action: ModeAction) => void;
}

export function useMode(initial: Mode = "nav"): UseModeResult {
  const [mode, dispatch] = useReducer(modeReducer, initial);
  return { mode, dispatch };
}
