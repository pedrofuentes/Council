# Council TUI — Milestone 9.2 (M1 App Shell & Navigation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the full-screen TUI app shell — a 3-zone alternate-screen layout with a collapsible left nav, semantic theming, responsive resize, a Home dashboard, a `?` help overlay, and the entry wiring so that bare `council` on a TTY (behind `COUNCIL_TUI=1`) launches the TUI while non-TTY falls back to today's help.

**Architecture:** New presentation code under `packages/cli/src/tui/`, composing the M0 primitives. Pure layout/theme logic is split from components so it's unit-tested without a terminal. The root `CouncilTUI` wires `react-router`'s `MemoryRouter`, the `AppShell`, the Home route, and global overlays. A small entry guard in `bin/council.ts` launches the TUI only on an interactive TTY with `COUNCIL_TUI=1`.

**Tech Stack:** TypeScript ESM, Ink 7 (`alternateScreen`, `useWindowSize`, `useInput`, `useApp`), React 19, `react-router` (`MemoryRouter`), `chalk`, Vitest + `ink-testing-library`. All four TUI deps and the M0 primitives are already on `main`.

## Global Constraints

Copied verbatim from `docs/designs/interactive-tui.md`, `AGENTS.md`, repo config, and **`LEARNINGS.md` (M0 spike)** — every task implicitly includes these:

- **Runtime:** Node ≥ 24; ESM. **Import specifiers end in `.js`** even for `.ts`/`.tsx` sources.
- **JSX:** classic runtime — every `.tsx` starts with `import React from "react";`.
- **Exports:** named exports only (no `default`). Explicit return types on exported functions/components. `interface` for object shapes. `readonly` by default. **No `any`** (use `unknown` + guards).
- **TDD ordering (Sentinel-enforced):** the `test(tui): …` commit MUST precede the `feat(tui): …` commit for behavior-bearing code; never combine them. Demonstrate RED.
- **⚠️ M0 LEARNINGS — apply to EVERY component/hook task (these caused M0 Sentinel rejections):**
  1. **Test the exported hook/component behavior, not just a pure helper.** Render via `ink-testing-library` and assert rendered output / callbacks.
  2. **Cover EVERY keyboard branch** you implement (each arrow, `Tab`, `Esc`, `Enter`, the `\` toggle, `?`). Partial coverage is rejected 🔴.
  3. **A lone `Esc` (`\u001b`) needs a REAL timer wait** in tests (`await sleep(120)`), NOT `setImmediate` `flush()` — Ink buffers it behind a real-time disambiguation timeout. Complete sequences (arrows `\u001b[A`/`\u001b[B`, `Tab` `\t`) are delivered immediately and work with `flush()`.
  4. **Sanitize untrusted strings before the terminal `<Text>` sink** with `toSingleLineDisplay` (single-line: breadcrumb, model id, nav labels, session titles, status messages) or `stripControlChars` (multi-line). Untrusted = anything from config, the DB (session/panel/expert names), or models.
- **Sanitizers:** `toSingleLineDisplay`, `stripControlChars` from `packages/cli/src/cli/strip-control-chars.js`. Symbols/ASCII fallback: `getSymbols()` from `packages/cli/src/cli/renderers/symbols.js`. Existing expert palette: `packages/cli/src/cli/renderers/ink/colors.js`.
- **`@github/copilot-sdk` boundary:** never import it outside `engine/copilot/adapter.ts`. M1 touches no engine code.
- **Per increment:** git worktree off `main` (never commit on `main`); `pnpm install --frozen-lockfile` in each fresh worktree; run `pnpm --filter @council-ai/cli test` + `lint` + `typecheck` before pushing; open a PR; the PARENT invokes Sentinel; merge only on APPROVED/CONDITIONAL.
- **Test color:** `tests/setup.ts` forces `FORCE_COLOR=3`, so Ink emits SGR sequences (`\u001b[7m` for `inverse`, color codes for `chalk`) in tests — assert against them when verifying highlight/active state.
- **Test location:** `packages/cli/tests/unit/tui/…`. Single file: `cd packages/cli && pnpm exec vitest run tests/unit/tui/<file>`.

## PR / worktree grouping (6 PRs)

| PR | Branch | Tasks |
|----|--------|-------|
| PR-A | `feature/tui-theme-breakpoints` | Task 1 (`resolveTheme`), Task 2 (`computeLayout`) — pure |
| PR-B | `feature/tui-layout` | Task 3 (`Header`), Task 4 (`Footer`), Task 5 (`AppShell`) |
| PR-C | `feature/tui-leftnav` | Task 6 (`LeftNav`) |
| PR-D | `feature/tui-home` | Task 7 (`loadHomeData` adapter), Task 8 (`HomeScreen`) |
| PR-E | `feature/tui-help-overlay` | Task 9 (`HelpModal`) |
| PR-F | `feature/tui-root-entry` | Task 10 (`CouncilTUI` root), Task 11 (`index.tsx` + `bin/council.ts` entry) |

PR-B/PR-C depend on PR-A (theme/breakpoints). PR-F depends on all. Rebase each on latest `main` after the prior PR merges.

## File Structure

```
packages/cli/src/tui/
  theme/
    tokens.ts             SemanticTheme, resolveTheme(env) — semantic colors + NO_COLOR/ASCII
  lib/
    breakpoints.ts        computeLayout({columns,rows,navOverride}) → LayoutPlan (pure)
    should-launch-tui.ts  shouldLaunchTui(argv, streams) → boolean (entry guard, pure)
  components/
    layout/
      Header.tsx          wordmark + breadcrumb + model + cost meter (compact-aware)
      Footer.tsx          contextual key hints + mode indicator + status (TTL) 
      AppShell.tsx        3-zone layout: Header / [LeftNav | Main] / Footer
    navigation/
      LeftNav.tsx         collapsible sections (expanded/rail/hidden), `\` toggle, keyboard nav
    overlays/
      HelpModal.tsx       `?` keybinding overlay; Esc closes
  screens/
    HomeScreen.tsx        recent sessions + quick actions + counts; empty state
  adapters/
    home-data.ts          loadHomeData(db) → HomeData view-model (counts + recent sessions)
  router/
    routes.ts             ROUTES constant
  CouncilTUI.tsx          root: MemoryRouter + AppShell + Home route + overlays + nav mode
  index.tsx               entry: shouldLaunchTui guard + render(<CouncilTUI/>, {alternateScreen})
packages/cli/src/bin/council.ts   (modify) — launch TUI on bare `council` + TTY + COUNCIL_TUI=1
packages/cli/tests/unit/tui/      (+ matching test files)
```

---

### Task 1: `resolveTheme` — semantic color tokens

**Files:**
- Create: `packages/cli/src/tui/theme/tokens.ts`
- Test: `packages/cli/tests/unit/tui/theme.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  interface SemanticTheme {
    readonly accent: (s: string) => string;
    readonly muted: (s: string) => string;
    readonly error: (s: string) => string;
    readonly warn: (s: string) => string;
    readonly success: (s: string) => string;
    readonly enabled: boolean; // false under NO_COLOR/dumb
  }
  function resolveTheme(env?: NodeJS.ProcessEnv): SemanticTheme
  ```
  When `NO_COLOR` (any non-empty) or `TERM=dumb` is set, every token is the identity function and `enabled` is `false`. Otherwise tokens apply `chalk` colors. Consumed by Header/Footer/LeftNav.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cli/tests/unit/tui/theme.test.ts
import { describe, expect, it } from "vitest";

import { resolveTheme } from "../../../src/tui/theme/tokens.js";

describe("resolveTheme", () => {
  it("applies color when color is enabled", () => {
    const t = resolveTheme({ FORCE_COLOR: "3" });
    expect(t.enabled).toBe(true);
    expect(t.accent("x")).not.toBe("x"); // wrapped in SGR codes
  });

  it("is identity under NO_COLOR", () => {
    const t = resolveTheme({ NO_COLOR: "1" });
    expect(t.enabled).toBe(false);
    expect(t.accent("x")).toBe("x");
    expect(t.error("e")).toBe("e");
  });

  it("is identity under TERM=dumb", () => {
    const t = resolveTheme({ TERM: "dumb" });
    expect(t.enabled).toBe(false);
    expect(t.muted("m")).toBe("m");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd packages/cli && pnpm exec vitest run tests/unit/tui/theme.test.ts` → FAIL (missing module).

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/cli/src/tui/theme/tokens.ts
import chalk, { type ChalkInstance } from "chalk";

export interface SemanticTheme {
  readonly accent: (s: string) => string;
  readonly muted: (s: string) => string;
  readonly error: (s: string) => string;
  readonly warn: (s: string) => string;
  readonly success: (s: string) => string;
  readonly enabled: boolean;
}

const identity = (s: string): string => s;

function colorDisabled(env: NodeJS.ProcessEnv): boolean {
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return true;
  if (env["TERM"] === "dumb") return true;
  return false;
}

export function resolveTheme(env: NodeJS.ProcessEnv = process.env): SemanticTheme {
  if (colorDisabled(env)) {
    return {
      accent: identity,
      muted: identity,
      error: identity,
      warn: identity,
      success: identity,
      enabled: false,
    };
  }
  const c: ChalkInstance = new chalk.Instance({ level: 1 });
  return {
    accent: (s) => c.cyan(s),
    muted: (s) => c.dim(s),
    error: (s) => c.red(s),
    warn: (s) => c.yellow(s),
    success: (s) => c.green(s),
    enabled: true,
  };
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS (3 tests).

- [ ] **Step 5: Commit (test first, then impl)**
```bash
git add packages/cli/tests/unit/tui/theme.test.ts && git commit -m "test(tui): add failing tests for resolveTheme"
git add packages/cli/src/tui/theme/tokens.ts && git commit -m "feat(tui): add semantic theme tokens with NO_COLOR support"
```
(Each commit ends with the `Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>` trailer; author `pedrofuentes`/`git@pedrofuent.es`.)

---

### Task 2: `computeLayout` — responsive breakpoints

**Files:**
- Create: `packages/cli/src/tui/lib/breakpoints.ts`
- Test: `packages/cli/tests/unit/tui/breakpoints.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  type NavState = "expanded" | "rail" | "hidden";
  interface LayoutPlan {
    readonly navState: NavState;
    readonly compactHeader: boolean;
    readonly footerLabels: boolean;   // false = icon-only footer
    readonly tooNarrow: boolean;      // < 60 cols: minimal warning mode
    readonly mainWidth: number;       // columns available to Main
  }
  interface LayoutInput {
    readonly columns: number;
    readonly rows: number;
    readonly navOverride?: NavState;  // manual `\` toggle wins over adaptive default
  }
  function computeLayout(input: LayoutInput): LayoutPlan
  ```
  Adaptive defaults (design §4.10): ≥120 → expanded; 80–119 → rail + compactHeader; 60–79 → hidden + icon-only footer; <60 → tooNarrow. `navOverride` (if provided) sets `navState` directly. Nav widths: expanded 14, rail 3, hidden 0.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cli/tests/unit/tui/breakpoints.test.ts
import { describe, expect, it } from "vitest";

import { computeLayout } from "../../../src/tui/lib/breakpoints.js";

describe("computeLayout", () => {
  it("expands the nav on wide terminals", () => {
    const l = computeLayout({ columns: 140, rows: 40 });
    expect(l.navState).toBe("expanded");
    expect(l.compactHeader).toBe(false);
    expect(l.footerLabels).toBe(true);
    expect(l.mainWidth).toBe(140 - 14);
  });

  it("uses the icon rail and compact header at medium width", () => {
    const l = computeLayout({ columns: 100, rows: 30 });
    expect(l.navState).toBe("rail");
    expect(l.compactHeader).toBe(true);
    expect(l.mainWidth).toBe(100 - 3);
  });

  it("hides the nav and footer labels when narrow", () => {
    const l = computeLayout({ columns: 70, rows: 24 });
    expect(l.navState).toBe("hidden");
    expect(l.footerLabels).toBe(false);
    expect(l.mainWidth).toBe(70);
  });

  it("flags too-narrow terminals", () => {
    expect(computeLayout({ columns: 50, rows: 20 }).tooNarrow).toBe(true);
  });

  it("honors a manual nav override over the adaptive default", () => {
    const l = computeLayout({ columns: 140, rows: 40, navOverride: "hidden" });
    expect(l.navState).toBe("hidden");
    expect(l.mainWidth).toBe(140);
  });
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/cli/src/tui/lib/breakpoints.ts
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
```

- [ ] **Step 4: Run to verify PASS (5 tests).**

- [ ] **Step 5: Commit (test → feat), as in Task 1.**

---

### Task 3: `Header` component

**Files:**
- Create: `packages/cli/src/tui/components/layout/Header.tsx`
- Test: `packages/cli/tests/unit/tui/header.test.tsx`

**Interfaces:**
- Consumes: `SemanticTheme` (Task 1).
- Produces:
  ```typescript
  interface HeaderProps {
    readonly breadcrumb: string;   // e.g. "Council ▸ architecture-review"
    readonly model: string;
    readonly premiumRequests?: number;
    readonly compact?: boolean;    // hide model+cost; minimal breadcrumb
    readonly theme: SemanticTheme;
  }
  function Header(props: HeaderProps): React.ReactElement
  ```
  **All text fields (`breadcrumb`, `model`) are untrusted — render via `toSingleLineDisplay`.**

- [ ] **Step 1: Write the failing test**

```tsx
// packages/cli/tests/unit/tui/header.test.tsx
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { Header } from "../../../src/tui/components/layout/Header.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

describe("Header", () => {
  it("shows the breadcrumb, model, and cost in full mode", () => {
    const { lastFrame, unmount } = render(
      <Header breadcrumb="Council ▸ panel" model="claude-sonnet-4.5" premiumRequests={6} theme={theme} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Council ▸ panel");
    expect(frame).toContain("claude-sonnet-4.5");
    expect(frame).toContain("6");
    unmount();
  });

  it("hides model and cost in compact mode", () => {
    const { lastFrame, unmount } = render(
      <Header breadcrumb="Council ▸ panel" model="claude-sonnet-4.5" premiumRequests={6} compact theme={theme} />,
    );
    expect(lastFrame() ?? "").not.toContain("claude-sonnet-4.5");
    unmount();
  });

  it("sanitizes control sequences in the breadcrumb and model", () => {
    const { lastFrame, unmount } = render(
      <Header breadcrumb={"Council\u0007 ▸ p"} model={"m\u001b[31mx"} theme={theme} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("\u0007");
    expect(frame).not.toContain("[31m");
    unmount();
  });
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/cli/src/tui/components/layout/Header.tsx
import React from "react";
import { Box, Text } from "ink";

import { toSingleLineDisplay } from "../../../cli/strip-control-chars.js";
import type { SemanticTheme } from "../../theme/tokens.js";

export interface HeaderProps {
  readonly breadcrumb: string;
  readonly model: string;
  readonly premiumRequests?: number;
  readonly compact?: boolean;
  readonly theme: SemanticTheme;
}

export function Header(props: HeaderProps): React.ReactElement {
  const breadcrumb = toSingleLineDisplay(props.breadcrumb);
  const model = toSingleLineDisplay(props.model);
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text>{props.theme.accent(`🏛 ${breadcrumb}`)}</Text>
      {props.compact !== true && (
        <Text>
          {props.theme.muted(model)}
          {props.premiumRequests !== undefined ? props.theme.muted(`  ◷ ${props.premiumRequests} req`) : ""}
        </Text>
      )}
    </Box>
  );
}
```

- [ ] **Step 4: Run to verify PASS (3 tests).**
- [ ] **Step 5: Commit (test → feat).**

---

### Task 4: `Footer` component

**Files:**
- Create: `packages/cli/src/tui/components/layout/Footer.tsx`
- Test: `packages/cli/tests/unit/tui/footer.test.tsx`

**Interfaces:**
- Consumes: `SemanticTheme`.
- Produces:
  ```typescript
  type FooterMode = "NAV" | "TYPE" | "STREAM";
  interface FooterHint { readonly key: string; readonly label: string }
  interface FooterProps {
    readonly hints: readonly FooterHint[];
    readonly mode: FooterMode;
    readonly status?: string;        // untrusted -> sanitize
    readonly showLabels?: boolean;   // false = icon-only
    readonly theme: SemanticTheme;
  }
  function Footer(props: FooterProps): React.ReactElement
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// packages/cli/tests/unit/tui/footer.test.tsx
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { Footer } from "../../../src/tui/components/layout/Footer.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });
const hints = [
  { key: "j/k", label: "move" },
  { key: "↵", label: "open" },
];

describe("Footer", () => {
  it("shows hint keys, labels, and the mode indicator", () => {
    const { lastFrame, unmount } = render(<Footer hints={hints} mode="NAV" showLabels theme={theme} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("j/k");
    expect(frame).toContain("move");
    expect(frame).toContain("NAV");
    unmount();
  });

  it("hides labels in icon-only mode but keeps keys", () => {
    const { lastFrame, unmount } = render(<Footer hints={hints} mode="NAV" showLabels={false} theme={theme} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("j/k");
    expect(frame).not.toContain("move");
    unmount();
  });

  it("sanitizes the status message", () => {
    const { lastFrame, unmount } = render(
      <Footer hints={hints} mode="NAV" status={"saved\u0007 ok"} showLabels theme={theme} />,
    );
    expect(lastFrame() ?? "").not.toContain("\u0007");
    unmount();
  });
});
```

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/cli/src/tui/components/layout/Footer.tsx
import React from "react";
import { Box, Text } from "ink";

import { toSingleLineDisplay } from "../../../cli/strip-control-chars.js";
import type { SemanticTheme } from "../../theme/tokens.js";

export type FooterMode = "NAV" | "TYPE" | "STREAM";

export interface FooterHint {
  readonly key: string;
  readonly label: string;
}

export interface FooterProps {
  readonly hints: readonly FooterHint[];
  readonly mode: FooterMode;
  readonly status?: string;
  readonly showLabels?: boolean;
  readonly theme: SemanticTheme;
}

export function Footer(props: FooterProps): React.ReactElement {
  const showLabels = props.showLabels ?? true;
  const hintText = props.hints
    .map((h) => (showLabels ? `${h.key} ${h.label}` : h.key))
    .join("   ");
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text>{props.theme.muted(hintText)}</Text>
      <Text>
        {props.status !== undefined ? props.theme.muted(toSingleLineDisplay(props.status) + "   ") : ""}
        {props.theme.accent(props.mode)}
      </Text>
    </Box>
  );
}
```

- [ ] **Step 4: PASS (3 tests).**
- [ ] **Step 5: Commit (test → feat).**

---

### Task 5: `AppShell` — 3-zone layout

**Files:**
- Create: `packages/cli/src/tui/components/layout/AppShell.tsx`
- Test: `packages/cli/tests/unit/tui/app-shell.test.tsx`

**Interfaces:**
- Consumes: `Header` (3), `Footer` (4), `LayoutPlan` (2).
- Produces:
  ```typescript
  interface AppShellProps {
    readonly layout: LayoutPlan;           // from computeLayout(useWindowSize())
    readonly header: React.ReactNode;
    readonly footer: React.ReactNode;
    readonly nav?: React.ReactNode;        // omitted/hidden when layout.navState === "hidden"
    readonly children: React.ReactNode;    // Main content
  }
  function AppShell(props: AppShellProps): React.ReactElement
  ```
  Renders Header on top, Footer on the bottom, and a middle row of `[nav?][Main]`. When `layout.tooNarrow`, render only a "Terminal too narrow (min 60 cols)" message. The nav is rendered only when `navState !== "hidden"` and `nav` is provided.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/cli/tests/unit/tui/app-shell.test.tsx
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";

import { AppShell } from "../../../src/tui/components/layout/AppShell.js";
import { computeLayout } from "../../../src/tui/lib/breakpoints.js";

describe("AppShell", () => {
  it("renders header, nav, main, and footer when wide", () => {
    const layout = computeLayout({ columns: 140, rows: 40 });
    const { lastFrame, unmount } = render(
      <AppShell
        layout={layout}
        header={<Text>HEADER</Text>}
        footer={<Text>FOOTER</Text>}
        nav={<Text>NAV</Text>}
      >
        <Text>MAIN</Text>
      </AppShell>,
    );
    const frame = lastFrame() ?? "";
    for (const part of ["HEADER", "NAV", "MAIN", "FOOTER"]) expect(frame).toContain(part);
    unmount();
  });

  it("omits the nav when navState is hidden", () => {
    const layout = computeLayout({ columns: 70, rows: 24 }); // hidden
    const { lastFrame, unmount } = render(
      <AppShell layout={layout} header={<Text>H</Text>} footer={<Text>F</Text>} nav={<Text>NAV</Text>}>
        <Text>MAIN</Text>
      </AppShell>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("MAIN");
    expect(frame).not.toContain("NAV");
    unmount();
  });

  it("shows a too-narrow warning under 60 cols", () => {
    const layout = computeLayout({ columns: 50, rows: 20 });
    const { lastFrame, unmount } = render(
      <AppShell layout={layout} header={<Text>H</Text>} footer={<Text>F</Text>}>
        <Text>MAIN</Text>
      </AppShell>,
    );
    expect((lastFrame() ?? "").toLowerCase()).toContain("too narrow");
    unmount();
  });
});
```

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/cli/src/tui/components/layout/AppShell.tsx
import React from "react";
import { Box, Text } from "ink";

import type { LayoutPlan } from "../../lib/breakpoints.js";

export interface AppShellProps {
  readonly layout: LayoutPlan;
  readonly header: React.ReactNode;
  readonly footer: React.ReactNode;
  readonly nav?: React.ReactNode;
  readonly children: React.ReactNode;
}

export function AppShell(props: AppShellProps): React.ReactElement {
  if (props.layout.tooNarrow) {
    return (
      <Box height="100%" alignItems="center" justifyContent="center">
        <Text>Terminal too narrow (min 60 cols)</Text>
      </Box>
    );
  }
  const showNav = props.layout.navState !== "hidden" && props.nav !== undefined;
  return (
    <Box flexDirection="column" height="100%">
      {props.header}
      <Box flexGrow={1}>
        {showNav ? <Box>{props.nav}</Box> : null}
        <Box flexGrow={1} flexDirection="column">
          {props.children}
        </Box>
      </Box>
      {props.footer}
    </Box>
  );
}
```

- [ ] **Step 4: PASS (3 tests).**
- [ ] **Step 5: Commit (test → feat).**

---

### Task 6: `LeftNav` — collapsible navigation

**Files:**
- Create: `packages/cli/src/tui/components/navigation/LeftNav.tsx`
- Test: `packages/cli/tests/unit/tui/left-nav.test.tsx`

**Interfaces:**
- Consumes: `NavState` (2), `SemanticTheme` (1).
- Produces:
  ```typescript
  interface NavItem { readonly id: string; readonly label: string; readonly glyph: string }
  interface LeftNavProps {
    readonly items: readonly NavItem[];
    readonly activeId: string;
    readonly state: NavState;               // "expanded" | "rail" (never rendered when "hidden")
    readonly onSelect: (id: string) => void;
    readonly isActive?: boolean;            // gates keyboard handling (default true)
    readonly theme: SemanticTheme;
  }
  function LeftNav(props: LeftNavProps): React.ReactElement
  ```
  Keyboard (when `isActive`): `j`/`↓` next, `k`/`↑` prev (wrapping), `Enter` selects the highlighted item via `onSelect`. Expanded shows `glyph + label`; rail shows `glyph` only. The active item is highlighted with `inverse`. **Sanitize labels with `toSingleLineDisplay`.** Selection cursor is internal state initialized to the `activeId` index.

- [ ] **Step 1: Write the failing test** — cover BOTH arrows, Enter, rail vs expanded, and highlight (apply M0 learning #2: every keyboard branch).

```tsx
// packages/cli/tests/unit/tui/left-nav.test.tsx
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { LeftNav } from "../../../src/tui/components/navigation/LeftNav.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ FORCE_COLOR: "3" });
const items = [
  { id: "home", label: "Home", glyph: "⌂" },
  { id: "panels", label: "Panels", glyph: "▥" },
  { id: "experts", label: "Experts", glyph: "◆" },
];
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

describe("LeftNav", () => {
  it("shows labels when expanded and highlights the active item", () => {
    const { lastFrame, unmount } = render(
      <LeftNav items={items} activeId="home" state="expanded" onSelect={() => {}} theme={theme} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Home");
    expect(frame).toContain("Panels");
    expect(frame).toContain("\u001b[7m"); // inverse on the active row
    unmount();
  });

  it("shows only glyphs in rail mode", () => {
    const { lastFrame, unmount } = render(
      <LeftNav items={items} activeId="home" state="rail" onSelect={() => {}} theme={theme} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⌂");
    expect(frame).not.toContain("Home");
    unmount();
  });

  it("selects the next item with j/down then Enter", async () => {
    let selected: string | undefined;
    const { stdin, unmount } = render(
      <LeftNav items={items} activeId="home" state="expanded" onSelect={(id) => { selected = id; }} theme={theme} />,
    );
    await flush();
    stdin.write("j"); // -> Panels
    await flush();
    stdin.write("\r");
    await flush();
    expect(selected).toBe("panels");
    unmount();
  });

  it("moves up with k and wraps, then selects with Enter", async () => {
    let selected: string | undefined;
    const { stdin, unmount } = render(
      <LeftNav items={items} activeId="home" state="expanded" onSelect={(id) => { selected = id; }} theme={theme} />,
    );
    await flush();
    stdin.write("k"); // wraps from Home(0) to Experts(2)
    await flush();
    stdin.write("\r");
    await flush();
    expect(selected).toBe("experts");
    unmount();
  });
});
```

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/cli/src/tui/components/navigation/LeftNav.tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

import { toSingleLineDisplay } from "../../../cli/strip-control-chars.js";
import type { NavState } from "../../lib/breakpoints.js";
import type { SemanticTheme } from "../../theme/tokens.js";

export interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly glyph: string;
}

export interface LeftNavProps {
  readonly items: readonly NavItem[];
  readonly activeId: string;
  readonly state: NavState;
  readonly onSelect: (id: string) => void;
  readonly isActive?: boolean;
  readonly theme: SemanticTheme;
}

export function LeftNav(props: LeftNavProps): React.ReactElement {
  const isActive = props.isActive ?? true;
  const initial = Math.max(0, props.items.findIndex((i) => i.id === props.activeId));
  const [cursor, setCursor] = useState(initial);
  const count = props.items.length;

  useInput(
    (input, key) => {
      if (key.downArrow || input === "j") {
        setCursor((c) => (count === 0 ? 0 : (c + 1) % count));
        return;
      }
      if (key.upArrow || input === "k") {
        setCursor((c) => (count === 0 ? 0 : (c - 1 + count) % count));
        return;
      }
      if (key.return) {
        const item = props.items[Math.min(cursor, count - 1)];
        if (item) props.onSelect(item.id);
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      {props.items.map((item, i) => {
        const label = toSingleLineDisplay(item.label);
        const text = props.state === "rail" ? item.glyph : `${item.glyph} ${label}`;
        return (
          <Text key={item.id} inverse={i === cursor}>
            {text}
          </Text>
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 4: PASS (4 tests).**
- [ ] **Step 5: Commit (test → feat).**

---

### Task 7: `loadHomeData` — Home dashboard adapter

**Files:**
- Create: `packages/cli/src/tui/adapters/home-data.ts`
- Test: `packages/cli/tests/unit/tui/home-data.test.ts`

**Interfaces:**
- Consumes: repositories over an open `CouncilDatabase` (use `PanelRepository`, `DebateRepository`/sessions query, `expert-library`/`FileExpertLibrary`, `panel-library-repo`). Investigate the exact repo methods at implementation time (see `docs/designs/interactive-tui.md §6.2`); the adapter must be a pure async function that takes its data sources by parameter so it can be unit-tested with fakes (no real DB).
- Produces:
  ```typescript
  interface RecentSession { readonly id: string; readonly title: string; readonly when: string; readonly status: "convened" | "concluded" }
  interface HomeData {
    readonly counts: { readonly sessions: number; readonly experts: number; readonly panels: number };
    readonly recent: readonly RecentSession[];
  }
  interface HomeDataSources {
    readonly listSessions: () => Promise<readonly RecentSession[]>;
    readonly countExperts: () => Promise<number>;
    readonly countPanels: () => Promise<number>;
  }
  function loadHomeData(sources: HomeDataSources): Promise<HomeData>
  ```
  `counts.sessions = recent.length` is NOT assumed — `listSessions` returns the recent slice; the adapter must also accept/derive a total. For M1 keep it simple: `counts.sessions` = length of the full session list returned by `listSessions` (cap `recent` to the newest 10 inside the adapter). **Session titles are untrusted — the adapter returns them raw; the SCREEN sanitizes at render.**

> Implementer note: the precise repository wiring (which method lists sessions, counts experts/panels) is determined during implementation by reading the repos referenced in design §6.2. The `HomeDataSources` indirection keeps this task unit-testable with fakes; a thin real-wiring function `createHomeDataSources(db)` is added in Task 10 (root) where the DB handle exists.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cli/tests/unit/tui/home-data.test.ts
import { describe, expect, it } from "vitest";

import { loadHomeData } from "../../../src/tui/adapters/home-data.js";

describe("loadHomeData", () => {
  it("aggregates counts and caps recent sessions to 10 newest", async () => {
    const sessions = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      title: `Session ${i}`,
      when: "2d",
      status: "convened" as const,
    }));
    const data = await loadHomeData({
      listSessions: () => Promise.resolve(sessions),
      countExperts: () => Promise.resolve(9),
      countPanels: () => Promise.resolve(5),
    });
    expect(data.counts).toEqual({ sessions: 12, experts: 9, panels: 5 });
    expect(data.recent).toHaveLength(10);
    expect(data.recent[0]?.id).toBe("s0");
  });

  it("handles an empty library", async () => {
    const data = await loadHomeData({
      listSessions: () => Promise.resolve([]),
      countExperts: () => Promise.resolve(0),
      countPanels: () => Promise.resolve(0),
    });
    expect(data.counts.sessions).toBe(0);
    expect(data.recent).toEqual([]);
  });
});
```

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/cli/src/tui/adapters/home-data.ts
export interface RecentSession {
  readonly id: string;
  readonly title: string;
  readonly when: string;
  readonly status: "convened" | "concluded";
}

export interface HomeData {
  readonly counts: { readonly sessions: number; readonly experts: number; readonly panels: number };
  readonly recent: readonly RecentSession[];
}

export interface HomeDataSources {
  readonly listSessions: () => Promise<readonly RecentSession[]>;
  readonly countExperts: () => Promise<number>;
  readonly countPanels: () => Promise<number>;
}

const RECENT_LIMIT = 10;

export async function loadHomeData(sources: HomeDataSources): Promise<HomeData> {
  const [sessions, experts, panels] = await Promise.all([
    sources.listSessions(),
    sources.countExperts(),
    sources.countPanels(),
  ]);
  return {
    counts: { sessions: sessions.length, experts, panels },
    recent: sessions.slice(0, RECENT_LIMIT),
  };
}
```

- [ ] **Step 4: PASS (2 tests).**
- [ ] **Step 5: Commit (test → feat).**

---

### Task 8: `HomeScreen`

**Files:**
- Create: `packages/cli/src/tui/screens/HomeScreen.tsx`
- Test: `packages/cli/tests/unit/tui/home-screen.test.tsx`

**Interfaces:**
- Consumes: `HomeData` (7), `SemanticTheme` (1).
- Produces:
  ```typescript
  interface HomeScreenProps { readonly data: HomeData; readonly theme: SemanticTheme }
  function HomeScreen(props: HomeScreenProps): React.ReactElement
  ```
  Populated: list recent session titles (**sanitized**) + `N sessions · M experts · K panels` + quick-action hints (`c Convene`, `e New expert`, `p New panel`, `, Settings`). Empty (`counts.sessions === 0` and no experts/panels): a centered CTA `⊕ Start your first Council session  [c]`.

- [ ] **Step 1: Write the failing test** (populated, empty, sanitization).

```tsx
// packages/cli/tests/unit/tui/home-screen.test.tsx
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { HomeScreen } from "../../../src/tui/screens/HomeScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });

describe("HomeScreen", () => {
  it("lists recent sessions, counts, and quick actions", () => {
    const { lastFrame, unmount } = render(
      <HomeScreen
        theme={theme}
        data={{
          counts: { sessions: 12, experts: 9, panels: 5 },
          recent: [{ id: "s1", title: "Microservices migration", when: "2d", status: "convened" }],
        }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Microservices migration");
    expect(frame).toContain("12 sessions");
    expect(frame).toContain("Convene");
    unmount();
  });

  it("shows an empty-state CTA when there is nothing yet", () => {
    const { lastFrame, unmount } = render(
      <HomeScreen theme={theme} data={{ counts: { sessions: 0, experts: 0, panels: 0 }, recent: [] }} />,
    );
    expect((lastFrame() ?? "").toLowerCase()).toContain("start your first");
    unmount();
  });

  it("sanitizes session titles", () => {
    const { lastFrame, unmount } = render(
      <HomeScreen
        theme={theme}
        data={{
          counts: { sessions: 1, experts: 0, panels: 0 },
          recent: [{ id: "s1", title: "evil\u0007\u001b[31m", when: "1d", status: "convened" }],
        }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("\u0007");
    expect(frame).not.toContain("[31m");
    unmount();
  });
});
```

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/cli/src/tui/screens/HomeScreen.tsx
import React from "react";
import { Box, Text } from "ink";

import { toSingleLineDisplay } from "../../../cli/strip-control-chars.js";
import type { HomeData } from "../adapters/home-data.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface HomeScreenProps {
  readonly data: HomeData;
  readonly theme: SemanticTheme;
}

const QUICK_ACTIONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "c", label: "Convene" },
  { key: "e", label: "New expert" },
  { key: "p", label: "New panel" },
  { key: ",", label: "Settings" },
];

export function HomeScreen(props: HomeScreenProps): React.ReactElement {
  const { counts, recent } = props.data;
  const empty = counts.sessions === 0 && counts.experts === 0 && counts.panels === 0;
  if (empty) {
    return (
      <Box height="100%" alignItems="center" justifyContent="center">
        <Text>{props.theme.accent("⊕ Start your first Council session  [c]")}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>{props.theme.muted("Recent sessions")}</Text>
      {recent.map((s) => (
        <Text key={s.id}>
          {`  ${s.status === "concluded" ? "✓" : "•"} ${toSingleLineDisplay(s.title)}  ${toSingleLineDisplay(s.when)}`}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text>{props.theme.muted(`${counts.sessions} sessions · ${counts.experts} experts · ${counts.panels} panels`)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>{QUICK_ACTIONS.map((a) => `${a.key} ${a.label}`).join("   ")}</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: PASS (3 tests).**
- [ ] **Step 5: Commit (test → feat).**

---

### Task 9: `HelpModal` overlay

**Files:**
- Create: `packages/cli/src/tui/components/overlays/HelpModal.tsx`
- Test: `packages/cli/tests/unit/tui/help-modal.test.tsx`

**Interfaces:**
- Produces:
  ```typescript
  interface HelpEntry { readonly keys: string; readonly description: string }
  interface HelpModalProps {
    readonly entries: readonly HelpEntry[];
    readonly onClose: () => void;
    readonly isActive?: boolean;
    readonly theme: SemanticTheme;
  }
  function HelpModal(props: HelpModalProps): React.ReactElement
  ```
  Renders a bordered list of keybindings; `Esc` (and `?`) closes via `onClose`. **Esc test MUST use a real-timer wait (M0 learning #3).**

- [ ] **Step 1: Write the failing test**

```tsx
// packages/cli/tests/unit/tui/help-modal.test.tsx
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { HelpModal } from "../../../src/tui/components/overlays/HelpModal.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({ NO_COLOR: "1" });
const entries = [
  { keys: "j/k", description: "move" },
  { keys: "Esc", description: "back" },
];
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("HelpModal", () => {
  it("lists keybindings", () => {
    const { lastFrame, unmount } = render(
      <HelpModal entries={entries} onClose={() => {}} theme={theme} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("j/k");
    expect(frame).toContain("move");
    unmount();
  });

  it("closes on Esc (real-timer wait — Ink buffers a lone Esc)", async () => {
    let closed = false;
    const { stdin, unmount } = render(
      <HelpModal entries={entries} onClose={() => { closed = true; }} theme={theme} />,
    );
    await sleep(20);
    stdin.write("\u001b");
    await sleep(120);
    expect(closed).toBe(true);
    unmount();
  });

  it("closes on ? as well", async () => {
    let closed = false;
    const { stdin, unmount } = render(
      <HelpModal entries={entries} onClose={() => { closed = true; }} theme={theme} />,
    );
    await new Promise((r) => setImmediate(r));
    stdin.write("?");
    await new Promise((r) => setImmediate(r));
    expect(closed).toBe(true);
    unmount();
  });
});
```

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/cli/src/tui/components/overlays/HelpModal.tsx
import React from "react";
import { Box, Text, useInput } from "ink";

import type { SemanticTheme } from "../../theme/tokens.js";

export interface HelpEntry {
  readonly keys: string;
  readonly description: string;
}

export interface HelpModalProps {
  readonly entries: readonly HelpEntry[];
  readonly onClose: () => void;
  readonly isActive?: boolean;
  readonly theme: SemanticTheme;
}

export function HelpModal(props: HelpModalProps): React.ReactElement {
  const isActive = props.isActive ?? true;
  useInput(
    (input, key) => {
      if (key.escape || input === "?") props.onClose();
    },
    { isActive },
  );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text>{props.theme.accent("Keyboard shortcuts")}</Text>
      {props.entries.map((e) => (
        <Text key={e.keys}>{`  ${e.keys}  ${e.description}`}</Text>
      ))}
    </Box>
  );
}
```

- [ ] **Step 4: PASS (3 tests).**
- [ ] **Step 5: Commit (test → feat).**

---

### Task 10: `CouncilTUI` root

**Files:**
- Create: `packages/cli/src/tui/CouncilTUI.tsx`
- Create: `packages/cli/src/tui/router/routes.ts`
- Test: `packages/cli/tests/unit/tui/council-tui.test.tsx`

**Interfaces:**
- Consumes: everything above + Ink `useWindowSize`, `useInput`, `useApp`; `react-router` `MemoryRouter`/`Routes`/`Route`/`useNavigate`.
- Produces:
  ```typescript
  interface CouncilTUIProps {
    readonly homeData: HomeData;            // injected (loaded by the entry before render) for testability
    readonly model: string;
    readonly env?: NodeJS.ProcessEnv;       // for resolveTheme (default process.env)
    readonly initialColumns?: number;       // test override; default useWindowSize().columns
    readonly initialRows?: number;
  }
  function CouncilTUI(props: CouncilTUIProps): React.ReactElement
  ```
  Behavior: computes `layout` from window size; renders `AppShell` with `Header` (breadcrumb "Council", `model`), `LeftNav` (sections Home/Panels/Experts/Sessions/Chats/Settings; Home active), `Footer` (NAV hints + mode); `Main` renders the active route (Home → `HomeScreen`). Global keys: `\` toggles nav (expanded↔hidden override), `?` opens `HelpModal`, `Esc` from Home → quit confirm (for M1: `Esc` closes help if open, else no-op/quit via `useApp().exit()` is acceptable but document it), `q` quits. `useWindowSize` drives responsive re-render. **For tests, accept `initialColumns/initialRows` to avoid depending on the live TTY size** (ink-testing-library reports a fixed width).

> Implementer note: this is the integration task — wire the pieces, keep logic minimal. The `homeData` is injected (not loaded here) so the component is render-only and testable. Real data loading happens in Task 11's entry. Use a `mode` state (`"nav" | "help"`) and gate `LeftNav` `isActive={mode==="nav"}` and `HelpModal` `isActive={mode==="help"}` per M0 dual-focus learning. Provide `routes.ts` with `export const ROUTES = { home: "/", panels: "/panels", experts: "/experts", sessions: "/sessions", chats: "/chats", settings: "/settings" } as const;`.

- [ ] **Step 1: Write the failing test** — render the root with injected data + fixed dimensions; assert Home content, nav sections, and footer render; assert `?` opens help and a real-timer `Esc` closes it.

```tsx
// packages/cli/tests/unit/tui/council-tui.test.tsx
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { CouncilTUI } from "../../../src/tui/CouncilTUI.js";
import type { HomeData } from "../../../src/tui/adapters/home-data.js";

const homeData: HomeData = {
  counts: { sessions: 3, experts: 2, panels: 1 },
  recent: [{ id: "s1", title: "Build vs buy", when: "2d", status: "convened" }],
};
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

describe("CouncilTUI", () => {
  it("renders the shell with Home content and nav sections", async () => {
    const { lastFrame, unmount } = render(
      <CouncilTUI homeData={homeData} model="claude-sonnet-4.5" env={{ NO_COLOR: "1" }} initialColumns={140} initialRows={40} />,
    );
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Build vs buy"); // Home screen
    expect(frame).toContain("Panels"); // left nav
    expect(frame).toContain("NAV"); // footer mode
    unmount();
  });

  it("opens help with ? and closes it with Esc", async () => {
    const { stdin, lastFrame, unmount } = render(
      <CouncilTUI homeData={homeData} model="m" env={{ NO_COLOR: "1" }} initialColumns={140} initialRows={40} />,
    );
    await flush();
    stdin.write("?");
    await flush();
    expect((lastFrame() ?? "").toLowerCase()).toContain("keyboard shortcuts");
    await sleep(20);
    stdin.write("\u001b");
    await sleep(120);
    expect((lastFrame() ?? "").toLowerCase()).not.toContain("keyboard shortcuts");
    unmount();
  });
});
```

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Write the implementation** — compose the shell. (The implementer writes `CouncilTUI.tsx` + `routes.ts`; keep it minimal and render-only. Use `useState` for `mode` and `navOverride`; `useWindowSize` with the `initialColumns/initialRows` override fallback; `useInput` at root for `?`→help, `\`→toggle nav, `q`→`useApp().exit()`. Render `MemoryRouter initialEntries={[ROUTES.home]}` with a `Route` for Home → `HomeScreen`. Gate `LeftNav`/`HelpModal` `isActive` by `mode`.)

> Because this integration component spans several files and Ink hooks, the implementer MUST write it to satisfy the test above exactly; if any assertion cannot be met (e.g. `useWindowSize` cannot be overridden), STOP and report BLOCKED with the specifics rather than weakening the test.

- [ ] **Step 4: Run to verify PASS (2 tests) + full suite + lint + typecheck.**
- [ ] **Step 5: Commit (test → feat).**

---

### Task 11: Entry wiring — `index.tsx` + `bin/council.ts`

**Files:**
- Create: `packages/cli/src/tui/lib/should-launch-tui.ts`
- Create: `packages/cli/src/tui/index.tsx`
- Modify: `packages/cli/src/bin/council.ts`
- Test: `packages/cli/tests/unit/tui/should-launch-tui.test.ts`
- Test: update `packages/cli/tests/unit/bin/council.test.ts` if it asserts bare-invocation behavior (check first).

**Interfaces:**
- Produces:
  ```typescript
  // should-launch-tui.ts (pure, the testable core of the entry decision)
  interface LaunchStreams { readonly stdout?: { readonly isTTY?: boolean }; readonly env?: NodeJS.ProcessEnv }
  function shouldLaunchTui(argv: readonly string[], streams?: LaunchStreams): boolean
  // index.tsx
  function launchTui(): Promise<void>   // loads home data, renders <CouncilTUI/> in alt-screen
  ```
  `shouldLaunchTui(argv, streams)` is `true` iff: there is NO subcommand in `argv` (i.e. `argv.slice(2)` contains no non-flag token), AND `stdout.isTTY === true`, AND `env.CI` is unset, AND `env.COUNCIL_TUI === "1"`, AND `env.COUNCIL_NO_TUI` is unset. (Reuses the spirit of M0's `isInteractive`; gated additionally behind `COUNCIL_TUI=1` during 9.2–9.9.)

- [ ] **Step 1: Write the failing test for `shouldLaunchTui`**

```typescript
// packages/cli/tests/unit/tui/should-launch-tui.test.ts
import { describe, expect, it } from "vitest";

import { shouldLaunchTui } from "../../../src/tui/lib/should-launch-tui.js";

const tty = { isTTY: true };
const base = (env: NodeJS.ProcessEnv) => ({ stdout: tty, env });

describe("shouldLaunchTui", () => {
  it("is true for bare `council` on a TTY with COUNCIL_TUI=1", () => {
    expect(shouldLaunchTui(["node", "council"], base({ COUNCIL_TUI: "1" }))).toBe(true);
  });
  it("is false when a subcommand is present", () => {
    expect(shouldLaunchTui(["node", "council", "convene"], base({ COUNCIL_TUI: "1" }))).toBe(false);
  });
  it("ignores global flags when detecting a bare invocation", () => {
    expect(shouldLaunchTui(["node", "council", "-q"], base({ COUNCIL_TUI: "1" }))).toBe(true);
  });
  it("is false without COUNCIL_TUI=1", () => {
    expect(shouldLaunchTui(["node", "council"], base({}))).toBe(false);
  });
  it("is false when not a TTY", () => {
    expect(shouldLaunchTui(["node", "council"], { stdout: { isTTY: false }, env: { COUNCIL_TUI: "1" } })).toBe(false);
  });
  it("is false under CI or COUNCIL_NO_TUI", () => {
    expect(shouldLaunchTui(["node", "council"], base({ COUNCIL_TUI: "1", CI: "true" }))).toBe(false);
    expect(shouldLaunchTui(["node", "council"], base({ COUNCIL_TUI: "1", COUNCIL_NO_TUI: "1" }))).toBe(false);
  });
});
```

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Write `should-launch-tui.ts`**

```typescript
// packages/cli/src/tui/lib/should-launch-tui.ts
export interface LaunchStreams {
  readonly stdout?: { readonly isTTY?: boolean };
  readonly env?: NodeJS.ProcessEnv;
}

export function shouldLaunchTui(argv: readonly string[], streams: LaunchStreams = {}): boolean {
  const stdout = streams.stdout ?? process.stdout;
  const env = streams.env ?? process.env;
  const hasSubcommand = argv.slice(2).some((a) => !a.startsWith("-"));
  if (hasSubcommand) return false;
  if (stdout.isTTY !== true) return false;
  if (env["CI"] !== undefined && env["CI"] !== "") return false;
  if (env["COUNCIL_NO_TUI"] !== undefined && env["COUNCIL_NO_TUI"] !== "") return false;
  return env["COUNCIL_TUI"] === "1";
}
```

- [ ] **Step 4: PASS.** Commit (test → feat) for `should-launch-tui.ts`.

- [ ] **Step 5: Add `index.tsx` (no separate unit test — it performs I/O; it is exercised manually and via the smoke check below).** It must: open the DB (`createDatabase` + `getCouncilDataHome`/paths from `config`), build `HomeDataSources` from the real repos (`createHomeDataSources(db)`), `await loadHomeData(...)`, load the configured model from `loadConfig()`, then `render(<CouncilTUI homeData={...} model={...} />, { alternateScreen: true, incrementalRendering: true })` from `ink`, and on exit close the DB. Wrap the tree in the M0 `ErrorBoundary` with `onError` calling the Ink app's `exit`. Commit as `feat(tui): add TUI entry (index.tsx) and home-data wiring`. (No test-first requirement is violated: `index.tsx` is I/O glue with no new pure logic — its logic lives in the tested `shouldLaunchTui`, `loadHomeData`, and `CouncilTUI`. If the implementer adds any branching logic here, it must be test-first.)

- [ ] **Step 6: Wire `bin/council.ts`.** First write/adjust a test in `tests/unit/bin/council.test.ts` asserting that the bare-invocation guard is consulted (inject `shouldLaunchTui`/`launchTui` seams so the test does not actually render). Then modify the `isMainModule` entry block: before `parseAsync`, `if (shouldLaunchTui(process.argv)) { await launchTui(); return; }`. Keep all existing behavior (help on bare non-TTY, all subcommands) unchanged. Commit test → feat.

> Implementer note: `buildProgram()` and `parseAsync` must remain the path for every subcommand and for bare non-TTY `council` (help). Only a bare, TTY, `COUNCIL_TUI=1` invocation short-circuits to the TUI. Verify `pnpm exec vitest run tests/unit/bin/council.test.ts` still passes and the command-ordering test is untouched.

- [ ] **Step 7: Pre-push + PR.** Full suite + lint + typecheck green. Manual smoke (document in PR body, not a CI test): `COUNCIL_TUI=1 node packages/cli/dist/bin/council.js` in a real terminal launches the shell; `COUNCIL_TUI=1 node … | cat` (non-TTY) prints help; `council doctor` still works.

---

## Per-PR closeout (every PR)
- [ ] Rebase on latest `main`. `pnpm install --frozen-lockfile` in the worktree.
- [ ] `cd packages/cli && pnpm exec vitest run tests/unit/tui` green; `pnpm --filter @council-ai/cli lint` zero warnings; `typecheck` clean.
- [ ] `git log --oneline main..HEAD` — every `test(tui)` precedes its `feat(tui)`.
- [ ] Push, open PR, parent invokes Sentinel, merge on APPROVED/CONDITIONAL, `git worktree remove` + `git branch -D`.

## Self-Review (completed)
- **Spec coverage:** design §4.1 (3-zone shell → Tasks 3/4/5), §4.2 (collapsible nav → Tasks 2/6), §4.10 (responsive + NO_COLOR → Tasks 1/2/5), §4.5 (footer hints + `?` help → Tasks 4/9/10), Home dashboard (Tasks 7/8), entry/`COUNCIL_TUI` (Task 11). Command palette (`^K`) and full nav-mode/typing-mode switching land in 9.3+ (palette) — M1 ships nav-mode + help only.
- **Placeholder scan:** pure-logic tasks (1,2,7,11-guard) have complete code; component tasks have complete test + impl; the two integration tasks (10 root, 11 entry I/O) give exact interfaces, tests, and explicit BLOCK-don't-weaken instructions because they touch Ink hooks/process I/O that must be verified at implementation time.
- **Type consistency:** `NavState`/`LayoutPlan` (2) → AppShell (5)/LeftNav (6); `SemanticTheme` (1) → all components; `HomeData` (7) → HomeScreen (8)/CouncilTUI (10); `shouldLaunchTui` (11) → bin entry.
- **M0 learnings applied:** every component test renders the component (not a pure stub), covers all keyboard branches, uses a real-timer wait for Esc (HelpModal, CouncilTUI), and asserts sanitization (Header, Footer, LeftNav, HomeScreen).

## Out of scope for M1 (later milestones)
Command palette `^K` (9.3), typing-mode/chat input, list/detail screens for Panels/Experts/Sessions (9.3), Settings overlay (9.4), and flipping bare `council` to default-launch the TUI (9.10). M1 ships the navigable shell + Home behind `COUNCIL_TUI=1`.
