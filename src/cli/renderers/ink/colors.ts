/**
 * Color assignment for experts in the Ink TUI.
 *
 * Each expert is assigned a stable color based on its index in the
 * panel roster, so the same expert renders in the same color across
 * every round, turn header, and message body. This gives users an
 * easy visual anchor in long debates without relying on reading the
 * name on every line.
 *
 * The palette uses Ink's named colors (which map to the basic 16-color
 * ANSI set) so output stays legible in any terminal.
 */

export const EXPERT_COLOR_PALETTE = ["cyan", "yellow", "magenta", "green", "blue", "red"] as const;

export type ExpertColor = (typeof EXPERT_COLOR_PALETTE)[number];

/** Returns a stable palette color for the given expert index. */
export function assignExpertColor(index: number): ExpertColor {
  const i =
    ((index % EXPERT_COLOR_PALETTE.length) + EXPERT_COLOR_PALETTE.length) %
    EXPERT_COLOR_PALETTE.length;
  return EXPERT_COLOR_PALETTE[i] as ExpertColor;
}
