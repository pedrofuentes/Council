export type NavState = "expanded" | "rail" | "hidden";

export interface LayoutPlan {
  readonly navState: NavState;
  readonly compactHeader: boolean;
  readonly footerLabels: boolean;
  readonly tooNarrow: boolean;
  readonly navWidth: number;
  readonly mainWidth: number;
  readonly columns: number;
  readonly rows: number;
  readonly contentHeight: number;
}

export interface LayoutInput {
  readonly columns: number;
  readonly rows: number;
  readonly navOverride?: NavState;
}

// ● 💬 Conversations (marker 1 + space 1 + emoji 2 + space 1 + 13 chars = 18)
// + paddingX={1} in LeftNav (2) + round border in AppShell (2) = 22 minimum.
// 24 adds two cols of breathing room so labels never sit flush against the border.
const NAV_WIDTH: Readonly<Record<NavState, number>> = { expanded: 24, rail: 3, hidden: 0 };

const CHROME_ROWS = 2;

// Each pane (nav/main) is wrapped in a bordered box: the top+bottom border
// consume two rows, and a single in-pane title label consumes one more. Subtract
// them so scroll-height consumers (e.g. DebateStreamScreen) never overflow the
// pinned terminal height.
const PANE_BORDER_ROWS = 2;
const PANE_TITLE_ROWS = 1;

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
  const navWidth = NAV_WIDTH[navState];
  const mainWidth = Math.max(0, input.columns - navWidth);
  const contentHeight = Math.max(0, input.rows - CHROME_ROWS - PANE_BORDER_ROWS - PANE_TITLE_ROWS);
  return {
    navState,
    compactHeader,
    footerLabels,
    tooNarrow,
    navWidth,
    mainWidth,
    columns: input.columns,
    rows: input.rows,
    contentHeight,
  };
}
