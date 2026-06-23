export type NavState = "expanded" | "rail" | "hidden";

export interface LayoutPlan {
  readonly navState: NavState;
  readonly compactHeader: boolean;
  readonly footerLabels: boolean;
  readonly tooNarrow: boolean;
  readonly mainWidth: number;
}

export interface LayoutInput {
  readonly columns: number;
  readonly rows: number;
  readonly navOverride?: NavState;
}

const NAV_WIDTH: Readonly<Record<NavState, number>> = { expanded: 14, rail: 3, hidden: 0 };

function adaptiveNav(columns: number): NavState {
  if (columns >= 120) return "expanded";
  if (columns >= 80) return "rail";
  return "hidden";
}

export function computeLayout(input: LayoutInput): LayoutPlan {
  const tooNarrow = input.columns < 60;
  const navState = input.navOverride ?? adaptiveNav(input.columns);
  const compactHeader = input.columns < 120;
  const footerLabels = input.columns >= 80;
  const mainWidth = Math.max(0, input.columns - NAV_WIDTH[navState]);
  return { navState, compactHeader, footerLabels, tooNarrow, mainWidth };
}
