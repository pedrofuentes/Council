/**
 * Focus modes the global key handler can observe. `palette` is part of the
 * union for completeness, but while the command palette owns input the global
 * handler is gated off (see {@link resolveEscape} note), so it is never
 * resolved here in practice.
 */
export type FocusMode = "nav" | "help" | "palette";

/** The action the global Esc key resolves to, in precedence order. */
export type EscapeAction = "closeHelp" | "back" | "quit";

export interface EscapeContext {
  readonly mode: FocusMode;
  readonly atHome: boolean;
}

/**
 * Pure escape-stack contract for the global Esc handler. Overlays and captured
 * screens claim Esc first (the handler is gated off for them); this resolves
 * the remaining global precedence:
 *
 * 1. help overlay open → close it;
 * 2. not on the home route → navigate back one history entry;
 * 3. otherwise (home) → quit the app.
 */
export function resolveEscape(ctx: EscapeContext): EscapeAction {
  if (ctx.mode === "help") {
    return "closeHelp";
  }
  if (!ctx.atHome) {
    return "back";
  }
  return "quit";
}
