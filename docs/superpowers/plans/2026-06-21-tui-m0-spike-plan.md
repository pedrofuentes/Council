# Council TUI — Milestone 9.1 (M0 Spike & De-risk) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and exhaustively test — in isolation, behind no user-facing entry point — the six riskiest Ink 7 primitives the Council TUI depends on, so later milestones build on proven foundations.

**Architecture:** New presentation-only code under `packages/cli/src/tui/`. M0 ships pure helpers (`fuzzyMatch`, `computeScrollWindow`, `isInteractive`), a `useMode` reducer/hook, and four Ink components (`ScrollView`, `MultilineInput`, `CommandPalette`, `ErrorBoundary`). Nothing is wired into `bin/council.ts` yet — M0 is a de-risking spike. All logic is reused as-is by milestone 9.2+.

**Tech Stack:** TypeScript (ESM), Ink 7, React 19, `ink-text-input`, `ink-select-input`, `react-router` (added but only smoke-tested in M0), `ink-testing-library` (dev), Vitest.

## Global Constraints

Copied verbatim from `docs/designs/interactive-tui.md`, `AGENTS.md`, and repo config — every task implicitly includes these:

- **Runtime:** Node.js ≥ 24; TypeScript ESM. **Import specifiers end in `.js`** even for `.ts`/`.tsx` sources (e.g. `import { useMode } from "./use-mode.js"`).
- **JSX:** classic runtime — every `.tsx` file starts with `import React from "react";`.
- **Exports:** named exports only (no `default` exports). Explicit return types on every exported function/component. `interface` for object shapes. `readonly` by default. **No `any`** — use `unknown` + type guards.
- **Sanitization:** any model/file/external string rendered to the terminal MUST pass through `toSingleLineDisplay` (single-line) or `stripControlChars` (multi-line) from `src/cli/strip-control-chars.js` before output. (Relevant to `CommandPalette` rendering item labels and `MultilineInput` echoing pasted text.)
- **Dependency boundary:** never import `@github/copilot-sdk` outside `src/engine/copilot/adapter.ts` (ESLint `no-restricted-imports`). M0 touches no engine code.
- **TDD ordering (Sentinel-enforced):** for every behavior-bearing task, the `test(tui): …` commit MUST precede the `feat(tui): …` commit. Never combine test + impl in one commit. Task 1 (deps) is a `chore` (TDD-exempt).
- **Per increment:** work in a git worktree off `main` (`git worktree add .worktrees/<name> -b <branch> main`), never commit on `main`. Run `pnpm --filter @council-ai/cli test` + `pnpm --filter @council-ai/cli lint` (zero warnings) before pushing. Open a PR; parent invokes Sentinel; merge only on APPROVED/CONDITIONAL.
- **Style:** Prettier (printWidth 100, double quotes, semicolons, trailing commas) + ESLint typescript-eslint strict — run before commit, fix all warnings.
- **Test location:** `packages/cli/tests/unit/tui/…`. Run a single file with `cd packages/cli && pnpm exec vitest run tests/unit/tui/<file>`.

## PR / worktree grouping

M0 has 10 tasks. Group them into **7 PRs** (each = one worktree, one Sentinel review). Tasks within a PR are still committed test-first, one behavior at a time:

| PR | Branch | Tasks |
|----|--------|-------|
| PR-0 | `chore/tui-deps` | Task 1 (add deps) |
| PR-1 | `feature/tui-pure-libs` | Tasks 2, 3, 4 (`isInteractive`, `fuzzyMatch`, `computeScrollWindow`) |
| PR-2 | `feature/tui-use-mode` | Task 5 (`useMode`) |
| PR-3 | `feature/tui-scrollview` | Task 6 (`ScrollView`) |
| PR-4 | `feature/tui-multiline-input` | Task 7 (`MultilineInput`) |
| PR-5 | `feature/tui-command-palette` | Task 8 (`CommandPalette`) |
| PR-6 | `feature/tui-errorboundary-and-vendor-smoke` | Tasks 9, 10 (`ErrorBoundary`, vendor smoke test) |

PR-1 depends on PR-0 (deps must exist). PR-3 depends on PR-1 (`computeScrollWindow`). PR-5 depends on PR-1 (`fuzzyMatch`) and benefits from PR-2 (`useMode`). PR-4/PR-6 depend only on PR-0. Rebase each branch on the latest `main` after the prior PR merges.

## File Structure

```
packages/cli/src/tui/
  lib/
    interactive.ts        isInteractive(streams?) — non-TTY/CI guard (pure)
    fuzzy.ts              fuzzyMatch(query, text) → { score, positions } | null (pure)
    scroll.ts             computeScrollWindow(opts) → { start, end, offset } (pure)
  hooks/
    use-mode.ts           Mode type, modeReducer, useMode() hook
  components/
    ErrorBoundary.tsx     class component; restores terminal + calls onError on crash
    lists/
      ScrollView.tsx      windowed list (uses computeScrollWindow + useWindowSize)
    inputs/
      MultilineInput.tsx  multi-line text input (useInput + usePaste)
    overlays/
      CommandPalette.tsx  fuzzy command palette (uses fuzzyMatch + useFocusManager)
packages/cli/tests/unit/tui/
  interactive.test.ts
  fuzzy.test.ts
  scroll.test.ts
  use-mode.test.ts
  scrollview.test.tsx
  multiline-input.test.tsx
  command-palette.test.tsx
  error-boundary.test.tsx
  vendor-smoke.test.tsx
```

Each file has one responsibility. Pure logic (`lib/`) is separated from rendering (`components/`) so the math is unit-tested without a terminal — the single most important testability decision in this plan.

---

### Task 1: Add approved dependencies

**Files:**
- Modify: `packages/cli/package.json` (dependencies + devDependencies)
- Modify: `pnpm-lock.yaml` (generated by pnpm — never hand-edit)

**Interfaces:**
- Produces: the npm packages `react-router`, `ink-text-input`, `ink-select-input` (runtime) and `ink-testing-library` (dev) available to all later tasks.

This is a `chore` (TDD-exempt — no behavior). Adding dependencies is an ASK-FIRST item in AGENTS.md; it was **already approved by the user** (recorded in `docs/designs/interactive-tui.md §6.4`).

- [ ] **Step 1: Add the runtime dependencies**

Run (from repo root):
```bash
pnpm --filter @council-ai/cli add react-router@^7 ink-text-input@^6 ink-select-input@^6
```

- [ ] **Step 2: Add the dev dependency**

Run:
```bash
pnpm --filter @council-ai/cli add -D ink-testing-library@^4
```

- [ ] **Step 3: Verify install + typecheck**

Run:
```bash
pnpm --filter @council-ai/cli typecheck
```
Expected: exits 0 (no type errors introduced).

- [ ] **Step 4: Verify the four packages resolve under Ink 7 / React 19**

Run:
```bash
node -e "import('ink-testing-library').then(()=>console.log('ok')).catch(e=>{console.error(e);process.exit(1)})"
```
Expected: prints `ok`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/package.json pnpm-lock.yaml
git commit -m "chore(tui): add react-router, ink-text-input, ink-select-input, ink-testing-library

Approved deps for the Phase 9 interactive TUI (docs/designs/interactive-tui.md §6.4).

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
```

---

### Task 2: `isInteractive()` non-TTY guard

**Files:**
- Create: `packages/cli/src/tui/lib/interactive.ts`
- Test: `packages/cli/tests/unit/tui/interactive.test.ts`

**Interfaces:**
- Produces: `isInteractive(streams?: { readonly stdout?: { readonly isTTY?: boolean }; readonly env?: NodeJS.ProcessEnv }): boolean` — returns `true` only when stdout is a TTY and the process is not in CI and `COUNCIL_NO_TUI` is unset. M0 ships the function; milestone 9.2 calls it from `bin/council.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cli/tests/unit/tui/interactive.test.ts
import { describe, expect, it } from "vitest";

import { isInteractive } from "../../../src/tui/lib/interactive.js";

describe("isInteractive", () => {
  it("is true for a TTY with no CI and no COUNCIL_NO_TUI", () => {
    expect(isInteractive({ stdout: { isTTY: true }, env: {} })).toBe(true);
  });

  it("is false when stdout is not a TTY", () => {
    expect(isInteractive({ stdout: { isTTY: false }, env: {} })).toBe(false);
  });

  it("is false when CI is set", () => {
    expect(isInteractive({ stdout: { isTTY: true }, env: { CI: "true" } })).toBe(false);
  });

  it("is false when COUNCIL_NO_TUI is set to any non-empty value", () => {
    expect(isInteractive({ stdout: { isTTY: true }, env: { COUNCIL_NO_TUI: "1" } })).toBe(false);
  });

  it("treats COUNCIL_NO_TUI='' (empty) as unset", () => {
    expect(isInteractive({ stdout: { isTTY: true }, env: { COUNCIL_NO_TUI: "" } })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm exec vitest run tests/unit/tui/interactive.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/tui/lib/interactive.js"`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/cli/src/tui/lib/interactive.ts

export interface InteractiveStreams {
  readonly stdout?: { readonly isTTY?: boolean };
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * True only when a full-screen TUI should launch: stdout is a TTY, the process
 * is not in CI, and the user has not opted out via COUNCIL_NO_TUI. Defaults to
 * the live process streams; injectable for tests.
 */
export function isInteractive(streams: InteractiveStreams = {}): boolean {
  const stdout = streams.stdout ?? process.stdout;
  const env = streams.env ?? process.env;
  if (stdout.isTTY !== true) return false;
  if (env.CI !== undefined && env.CI !== "") return false;
  if (env.COUNCIL_NO_TUI !== undefined && env.COUNCIL_NO_TUI !== "") return false;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm exec vitest run tests/unit/tui/interactive.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit (test first, then impl)**

```bash
git add packages/cli/tests/unit/tui/interactive.test.ts
git commit -m "test(tui): add failing tests for isInteractive guard

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
git add packages/cli/src/tui/lib/interactive.ts
git commit -m "feat(tui): add isInteractive non-TTY/CI guard

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
```

> If staging both in one commit is unavoidable, this task FAILS the TDD ordering check. Always two commits.

---

### Task 3: `fuzzyMatch` subsequence matcher

**Files:**
- Create: `packages/cli/src/tui/lib/fuzzy.ts`
- Test: `packages/cli/tests/unit/tui/fuzzy.test.ts`

**Interfaces:**
- Produces: `fuzzyMatch(query: string, text: string): FuzzyResult | null` where `interface FuzzyResult { readonly score: number; readonly positions: readonly number[] }`. Case-insensitive subsequence match; `null` when `query` is not a subsequence of `text`. Higher `score` = better (denser, earlier matches). Empty query matches everything with `score: 0` and `positions: []`. Used by `CommandPalette` (Task 8).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cli/tests/unit/tui/fuzzy.test.ts
import { describe, expect, it } from "vitest";

import { fuzzyMatch } from "../../../src/tui/lib/fuzzy.js";

describe("fuzzyMatch", () => {
  it("matches a subsequence case-insensitively", () => {
    const r = fuzzyMatch("nse", "New Session");
    expect(r).not.toBeNull();
    expect(r?.positions).toEqual([0, 4, 5]); // N(0) s(4) e(5)
  });

  it("returns null when not a subsequence", () => {
    expect(fuzzyMatch("zzz", "New Session")).toBeNull();
  });

  it("returns score 0 and empty positions for an empty query", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("scores a contiguous run higher than a scattered one", () => {
    const contiguous = fuzzyMatch("ses", "Session");
    const scattered = fuzzyMatch("ses", "Some Extra Stuff");
    expect(contiguous).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect((contiguous as { score: number }).score).toBeGreaterThan(
      (scattered as { score: number }).score,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm exec vitest run tests/unit/tui/fuzzy.test.ts`
Expected: FAIL — cannot resolve `fuzzy.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/cli/src/tui/lib/fuzzy.ts

export interface FuzzyResult {
  readonly score: number;
  readonly positions: readonly number[];
}

/**
 * Case-insensitive subsequence match. Returns matched character indices and a
 * score that rewards contiguous, early matches; null when `query` is not a
 * subsequence of `text`. An empty query matches everything (score 0).
 */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  if (query.length === 0) return { score: 0, positions: [] };

  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions: number[] = [];

  let ti = 0;
  let score = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi];
    let found = -1;
    for (; ti < t.length; ti += 1) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
    }
    if (found === -1) return null;
    positions.push(found);
    // Reward contiguity (adjacent to previous match) and earliness.
    score += found === prev + 1 ? 3 : 1;
    score += found < 4 ? 1 : 0;
    prev = found;
    ti = found + 1;
  }
  return { score, positions };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm exec vitest run tests/unit/tui/fuzzy.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit (test first, then impl)**

```bash
git add packages/cli/tests/unit/tui/fuzzy.test.ts
git commit -m "test(tui): add failing tests for fuzzyMatch

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
git add packages/cli/src/tui/lib/fuzzy.ts
git commit -m "feat(tui): add fuzzy subsequence matcher

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
```

---

### Task 4: `computeScrollWindow` math

**Files:**
- Create: `packages/cli/src/tui/lib/scroll.ts`
- Test: `packages/cli/tests/unit/tui/scroll.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  interface ScrollWindowInput {
    readonly total: number;        // number of items
    readonly viewport: number;     // visible rows (>= 1)
    readonly cursor: number;       // selected index (0..total-1), or -1 if none
    readonly offset: number;       // current scroll offset (top visible index)
    readonly follow: boolean;      // pin to bottom while true
  }
  interface ScrollWindow {
    readonly start: number;        // first visible index (inclusive)
    readonly end: number;          // last visible index (exclusive)
    readonly offset: number;       // new scroll offset (clamped)
  }
  function computeScrollWindow(input: ScrollWindowInput): ScrollWindow
  ```
  Used by `ScrollView` (Task 6). Pure — no React.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cli/tests/unit/tui/scroll.test.ts
import { describe, expect, it } from "vitest";

import { computeScrollWindow } from "../../../src/tui/lib/scroll.js";

describe("computeScrollWindow", () => {
  it("shows the whole list when it fits", () => {
    expect(computeScrollWindow({ total: 3, viewport: 10, cursor: 0, offset: 0, follow: false }))
      .toEqual({ start: 0, end: 3, offset: 0 });
  });

  it("pins to the bottom when follow is true", () => {
    expect(computeScrollWindow({ total: 100, viewport: 10, cursor: 0, offset: 0, follow: true }))
      .toEqual({ start: 90, end: 100, offset: 90 });
  });

  it("scrolls down to keep the cursor visible", () => {
    // cursor at 15, viewport 10, currently showing 0..10 -> must shift so 15 is visible
    expect(computeScrollWindow({ total: 100, viewport: 10, cursor: 15, offset: 0, follow: false }))
      .toEqual({ start: 6, end: 16, offset: 6 });
  });

  it("scrolls up to keep the cursor visible", () => {
    expect(computeScrollWindow({ total: 100, viewport: 10, cursor: 3, offset: 20, follow: false }))
      .toEqual({ start: 3, end: 13, offset: 3 });
  });

  it("clamps offset within bounds", () => {
    expect(computeScrollWindow({ total: 5, viewport: 10, cursor: 0, offset: 99, follow: false }))
      .toEqual({ start: 0, end: 5, offset: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm exec vitest run tests/unit/tui/scroll.test.ts`
Expected: FAIL — cannot resolve `scroll.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/cli/src/tui/lib/scroll.ts

export interface ScrollWindowInput {
  readonly total: number;
  readonly viewport: number;
  readonly cursor: number;
  readonly offset: number;
  readonly follow: boolean;
}

export interface ScrollWindow {
  readonly start: number;
  readonly end: number;
  readonly offset: number;
}

/**
 * Pure windowing math for a vertically scrolling list. Keeps the cursor visible,
 * pins to the bottom while `follow` is true, and clamps the offset to valid
 * bounds. `viewport` is the number of visible rows.
 */
export function computeScrollWindow(input: ScrollWindowInput): ScrollWindow {
  const viewport = Math.max(1, input.viewport);
  const maxOffset = Math.max(0, input.total - viewport);

  let offset: number;
  if (input.follow) {
    offset = maxOffset;
  } else if (input.cursor >= 0 && input.cursor < input.offset) {
    offset = input.cursor; // cursor above window -> scroll up
  } else if (input.cursor >= input.offset + viewport) {
    offset = input.cursor - viewport + 1; // cursor below window -> scroll down
  } else {
    offset = input.offset;
  }

  offset = Math.min(Math.max(0, offset), maxOffset);
  return { start: offset, end: Math.min(input.total, offset + viewport), offset };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm exec vitest run tests/unit/tui/scroll.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit (test first, then impl)**

```bash
git add packages/cli/tests/unit/tui/scroll.test.ts
git commit -m "test(tui): add failing tests for computeScrollWindow

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
git add packages/cli/src/tui/lib/scroll.ts
git commit -m "feat(tui): add scroll window math

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
```

---

### Task 5: `useMode` reducer + hook

**Files:**
- Create: `packages/cli/src/tui/hooks/use-mode.ts`
- Test: `packages/cli/tests/unit/tui/use-mode.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  type Mode = "nav" | "typing" | "palette";
  type ModeAction =
    | { readonly type: "enterTyping" }
    | { readonly type: "exitTyping" }
    | { readonly type: "openPalette" }
    | { readonly type: "closePalette" };
  function modeReducer(state: Mode, action: ModeAction): Mode
  function useMode(initial?: Mode): { readonly mode: Mode; readonly dispatch: (a: ModeAction) => void }
  ```
  The reducer is the testable core (no React needed). `useMode` wraps it with `React.useReducer`. Consumed by every screen in 9.2+ to gate `useInput({ isActive })`.

- [ ] **Step 1: Write the failing test (reducer is pure — no rendering needed)**

```typescript
// packages/cli/tests/unit/tui/use-mode.test.ts
import { describe, expect, it } from "vitest";

import { modeReducer } from "../../../src/tui/hooks/use-mode.js";

describe("modeReducer", () => {
  it("enters and exits typing mode", () => {
    expect(modeReducer("nav", { type: "enterTyping" })).toBe("typing");
    expect(modeReducer("typing", { type: "exitTyping" })).toBe("nav");
  });

  it("opens the palette from any mode and closes back to nav", () => {
    expect(modeReducer("nav", { type: "openPalette" })).toBe("palette");
    expect(modeReducer("typing", { type: "openPalette" })).toBe("palette");
    expect(modeReducer("palette", { type: "closePalette" })).toBe("nav");
  });

  it("ignores exitTyping when not typing", () => {
    expect(modeReducer("nav", { type: "exitTyping" })).toBe("nav");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm exec vitest run tests/unit/tui/use-mode.test.ts`
Expected: FAIL — cannot resolve `use-mode.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm exec vitest run tests/unit/tui/use-mode.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit (test first, then impl)**

```bash
git add packages/cli/tests/unit/tui/use-mode.test.ts
git commit -m "test(tui): add failing tests for modeReducer

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
git add packages/cli/src/tui/hooks/use-mode.ts
git commit -m "feat(tui): add useMode nav/typing/palette reducer hook

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
```

---

### Task 6: `ScrollView` component

**Files:**
- Create: `packages/cli/src/tui/components/lists/ScrollView.tsx`
- Test: `packages/cli/tests/unit/tui/scrollview.test.tsx`

**Interfaces:**
- Consumes: `computeScrollWindow` (Task 4).
- Produces:
  ```typescript
  interface ScrollViewProps {
    readonly items: readonly string[];
    readonly height: number;       // viewport rows
    readonly cursor?: number;      // highlighted index (default -1)
    readonly follow?: boolean;     // pin to bottom (default false)
  }
  function ScrollView(props: ScrollViewProps): React.ReactElement
  ```
  Renders only the visible slice (windowed). Highlights the cursor row with `inverse`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/cli/tests/unit/tui/scrollview.test.tsx
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { ScrollView } from "../../../src/tui/components/lists/ScrollView.js";

const items = Array.from({ length: 50 }, (_, i) => `item-${i}`);

describe("ScrollView", () => {
  it("renders only the visible window of items", () => {
    const { lastFrame, unmount } = render(
      <ScrollView items={items} height={5} cursor={0} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("item-0");
    expect(frame).toContain("item-4");
    expect(frame).not.toContain("item-5");
    unmount();
  });

  it("pins to the bottom when follow is true", () => {
    const { lastFrame, unmount } = render(
      <ScrollView items={items} height={5} follow />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("item-49");
    expect(frame).not.toContain("item-0");
    unmount();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm exec vitest run tests/unit/tui/scrollview.test.tsx`
Expected: FAIL — cannot resolve `ScrollView.js`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/cli/src/tui/components/lists/ScrollView.tsx
import React from "react";
import { Box, Text } from "ink";

import { computeScrollWindow } from "../../lib/scroll.js";

export interface ScrollViewProps {
  readonly items: readonly string[];
  readonly height: number;
  readonly cursor?: number;
  readonly follow?: boolean;
}

export function ScrollView(props: ScrollViewProps): React.ReactElement {
  const cursor = props.cursor ?? -1;
  const follow = props.follow ?? false;
  const { start, end } = computeScrollWindow({
    total: props.items.length,
    viewport: props.height,
    cursor,
    offset: 0,
    follow,
  });

  const visible = props.items.slice(start, end);
  return (
    <Box flexDirection="column">
      {visible.map((item, i) => {
        const index = start + i;
        return (
          <Text key={index} inverse={index === cursor}>
            {item}
          </Text>
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm exec vitest run tests/unit/tui/scrollview.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit (test first, then impl)**

```bash
git add packages/cli/tests/unit/tui/scrollview.test.tsx
git commit -m "test(tui): add failing tests for ScrollView

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
git add packages/cli/src/tui/components/lists/ScrollView.tsx
git commit -m "feat(tui): add windowed ScrollView component

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
```

---

### Task 7: `MultilineInput` component

**Files:**
- Create: `packages/cli/src/tui/components/inputs/MultilineInput.tsx`
- Test: `packages/cli/tests/unit/tui/multiline-input.test.tsx`

**Interfaces:**
- Produces:
  ```typescript
  interface MultilineInputProps {
    readonly value: string;                       // controlled value (lines joined by "\n")
    readonly onChange: (value: string) => void;
    readonly onSubmit?: (value: string) => void;  // fired on Enter
    readonly isActive?: boolean;                   // default true; gates key handling
  }
  function MultilineInput(props: MultilineInputProps): React.ReactElement
  ```
  Enter submits; Shift+Enter / Ctrl+J inserts a newline; Backspace deletes; printable chars insert at end (spike-level: append-only cursor). Controlled — parent owns `value`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/cli/tests/unit/tui/multiline-input.test.tsx
import React, { useState } from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { MultilineInput } from "../../../src/tui/components/inputs/MultilineInput.js";

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

function Harness(props: { readonly onSubmit?: (v: string) => void }): React.ReactElement {
  const [value, setValue] = useState("");
  return <MultilineInput value={value} onChange={setValue} onSubmit={props.onSubmit} />;
}

describe("MultilineInput", () => {
  it("appends typed characters to the value", async () => {
    const { stdin, lastFrame, unmount } = render(<Harness />);
    await flush();
    stdin.write("hi");
    await flush();
    expect(lastFrame() ?? "").toContain("hi");
    unmount();
  });

  it("submits the current value on Enter", async () => {
    let submitted: string | undefined;
    const { stdin, unmount } = render(<Harness onSubmit={(v) => { submitted = v; }} />);
    await flush();
    stdin.write("ok");
    await flush();
    stdin.write("\r"); // Enter
    await flush();
    expect(submitted).toBe("ok");
    unmount();
  });

  it("inserts a newline on Ctrl+J instead of submitting", async () => {
    let submitted: string | undefined;
    const { stdin, lastFrame, unmount } = render(<Harness onSubmit={(v) => { submitted = v; }} />);
    await flush();
    stdin.write("a");
    await flush();
    stdin.write("\n"); // Ctrl+J / line feed
    await flush();
    stdin.write("b");
    await flush();
    expect(submitted).toBeUndefined();
    expect(lastFrame() ?? "").toContain("a");
    expect(lastFrame() ?? "").toContain("b");
    unmount();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm exec vitest run tests/unit/tui/multiline-input.test.tsx`
Expected: FAIL — cannot resolve `MultilineInput.js`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/cli/src/tui/components/inputs/MultilineInput.tsx
import React from "react";
import { Box, Text, useInput } from "ink";

export interface MultilineInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit?: (value: string) => void;
  readonly isActive?: boolean;
}

export function MultilineInput(props: MultilineInputProps): React.ReactElement {
  const isActive = props.isActive ?? true;

  useInput(
    (input, key) => {
      // Ink reports the Enter key as `key.return`; a raw "\n" (Ctrl+J / LF)
      // arrives as input without key.return and means "insert newline".
      if (key.return) {
        props.onSubmit?.(props.value);
        return;
      }
      if (input === "\n") {
        props.onChange(props.value + "\n");
        return;
      }
      if (key.backspace || key.delete) {
        props.onChange(props.value.slice(0, -1));
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        props.onChange(props.value + input);
      }
    },
    { isActive },
  );

  const lines = props.value.split("\n");
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>{line.length > 0 ? line : " "}</Text>
      ))}
    </Box>
  );
}
```

> Note for reviewers: this is a spike-level append-only editor (no mid-line cursor). Full cursor/paste support is built in milestone 9.7; M0 only proves the keyboard-routing and newline-vs-submit distinction works under Ink 7.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm exec vitest run tests/unit/tui/multiline-input.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit (test first, then impl)**

```bash
git add packages/cli/tests/unit/tui/multiline-input.test.tsx
git commit -m "test(tui): add failing tests for MultilineInput

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
git add packages/cli/src/tui/components/inputs/MultilineInput.tsx
git commit -m "feat(tui): add spike MultilineInput (newline vs submit routing)

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
```

---

### Task 8: `CommandPalette` component

**Files:**
- Create: `packages/cli/src/tui/components/overlays/CommandPalette.tsx`
- Test: `packages/cli/tests/unit/tui/command-palette.test.tsx`

**Interfaces:**
- Consumes: `fuzzyMatch` (Task 3); `toSingleLineDisplay` from `src/cli/strip-control-chars.js`.
- Produces:
  ```typescript
  interface PaletteCommand { readonly id: string; readonly label: string }
  interface CommandPaletteProps {
    readonly commands: readonly PaletteCommand[];
    readonly onSelect: (id: string) => void;
    readonly onClose: () => void;
    readonly isActive?: boolean; // default true
  }
  function CommandPalette(props: CommandPaletteProps): React.ReactElement
  ```
  Typing filters via `fuzzyMatch` (best score first); ↑/↓ move selection; Enter selects; Esc closes. Labels are sanitized with `toSingleLineDisplay` before render.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/cli/tests/unit/tui/command-palette.test.tsx
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { CommandPalette } from "../../../src/tui/components/overlays/CommandPalette.js";

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

const commands = [
  { id: "new", label: "New Session" },
  { id: "exp", label: "Create Expert" },
  { id: "set", label: "Settings" },
];

describe("CommandPalette", () => {
  it("filters commands by fuzzy query and selects on Enter", async () => {
    let selected: string | undefined;
    const { stdin, lastFrame, unmount } = render(
      <CommandPalette commands={commands} onSelect={(id) => { selected = id; }} onClose={() => {}} />,
    );
    await flush();
    stdin.write("nse"); // matches "New Session"
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("New Session");
    expect(frame).not.toContain("Settings");
    stdin.write("\r"); // Enter selects the top result
    await flush();
    expect(selected).toBe("new");
    unmount();
  });

  it("closes on Esc", async () => {
    let closed = false;
    const { stdin, unmount } = render(
      <CommandPalette commands={commands} onSelect={() => {}} onClose={() => { closed = true; }} />,
    );
    await flush();
    stdin.write("\x1b"); // Esc
    await flush();
    expect(closed).toBe(true);
    unmount();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm exec vitest run tests/unit/tui/command-palette.test.tsx`
Expected: FAIL — cannot resolve `CommandPalette.js`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/cli/src/tui/components/overlays/CommandPalette.tsx
import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";

import { fuzzyMatch } from "../../lib/fuzzy.js";
import { toSingleLineDisplay } from "../../../cli/strip-control-chars.js";

export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
}

export interface CommandPaletteProps {
  readonly commands: readonly PaletteCommand[];
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
  readonly isActive?: boolean;
}

export function CommandPalette(props: CommandPaletteProps): React.ReactElement {
  const isActive = props.isActive ?? true;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const results = useMemo(() => {
    return props.commands
      .map((cmd) => ({ cmd, match: fuzzyMatch(query, cmd.label) }))
      .filter((r): r is { cmd: PaletteCommand; match: { score: number; positions: readonly number[] } } =>
        r.match !== null,
      )
      .sort((a, b) => b.match.score - a.match.score);
  }, [props.commands, query]);

  useInput(
    (input, key) => {
      if (key.escape) {
        props.onClose();
        return;
      }
      if (key.return) {
        const chosen = results[Math.min(selected, results.length - 1)];
        if (chosen) props.onSelect(chosen.cmd.id);
        return;
      }
      if (key.upArrow) {
        setSelected((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setSelected((s) => Math.min(results.length - 1, s + 1));
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        setSelected(0);
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
        setSelected(0);
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text>{`> ${toSingleLineDisplay(query)}`}</Text>
      {results.map((r, i) => (
        <Text key={r.cmd.id} inverse={i === Math.min(selected, results.length - 1)}>
          {toSingleLineDisplay(r.cmd.label)}
        </Text>
      ))}
    </Box>
  );
}
```

> Focus-stealing note: in the full app (9.2+) the parent gates all other `useInput` handlers with `isActive={mode !== "palette"}` and the palette mounts with `isActive` true, so it captures all keys while open. M0 verifies the palette's own keyboard handling in isolation; the `useFocusManager().disableFocus()` integration is exercised in 9.2 where a focus tree exists.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm exec vitest run tests/unit/tui/command-palette.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit (test first, then impl)**

```bash
git add packages/cli/tests/unit/tui/command-palette.test.tsx
git commit -m "test(tui): add failing tests for CommandPalette

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
git add packages/cli/src/tui/components/overlays/CommandPalette.tsx
git commit -m "feat(tui): add fuzzy CommandPalette overlay

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
```

---

### Task 9: `ErrorBoundary` (terminal restore on crash)

**Files:**
- Create: `packages/cli/src/tui/components/ErrorBoundary.tsx`
- Test: `packages/cli/tests/unit/tui/error-boundary.test.tsx`

**Interfaces:**
- Produces:
  ```typescript
  interface ErrorBoundaryProps {
    readonly onError: (error: Error) => void;  // parent calls useApp().exit() here in 9.2
    readonly fallback?: React.ReactNode;
    readonly children: React.ReactNode;
  }
  class ErrorBoundary extends React.Component<ErrorBoundaryProps, { hasError: boolean }>
  ```
  Catches render errors in children, calls `onError(error)` exactly once, and renders `fallback` (default: a one-line message) instead of crashing the Ink tree — so the parent can exit alt-screen cleanly.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/cli/tests/unit/tui/error-boundary.test.tsx
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Text } from "ink";

import { ErrorBoundary } from "../../../src/tui/components/ErrorBoundary.js";

function Boom(): React.ReactElement {
  throw new Error("kaboom");
}

describe("ErrorBoundary", () => {
  it("catches a child render error and calls onError", () => {
    let captured: Error | undefined;
    const { lastFrame, unmount } = render(
      <ErrorBoundary onError={(e) => { captured = e; }} fallback={<Text>recovered</Text>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(captured?.message).toBe("kaboom");
    expect(lastFrame() ?? "").toContain("recovered");
    unmount();
  });

  it("renders children normally when there is no error", () => {
    const { lastFrame, unmount } = render(
      <ErrorBoundary onError={() => {}}>
        <Text>healthy</Text>
      </ErrorBoundary>,
    );
    expect(lastFrame() ?? "").toContain("healthy");
    unmount();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm exec vitest run tests/unit/tui/error-boundary.test.tsx`
Expected: FAIL — cannot resolve `ErrorBoundary.js`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/cli/src/tui/components/ErrorBoundary.tsx
import React from "react";
import { Text } from "ink";

export interface ErrorBoundaryProps {
  readonly onError: (error: Error) => void;
  readonly fallback?: React.ReactNode;
  readonly children: React.ReactNode;
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  public componentDidCatch(error: Error): void {
    this.props.onError(error);
  }

  public render(): React.ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? <Text>Council hit an unexpected error and is exiting.</Text>;
    }
    return this.props.children;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm exec vitest run tests/unit/tui/error-boundary.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit (test first, then impl)**

```bash
git add packages/cli/tests/unit/tui/error-boundary.test.tsx
git commit -m "test(tui): add failing tests for ErrorBoundary

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
git add packages/cli/src/tui/components/ErrorBoundary.tsx
git commit -m "feat(tui): add ErrorBoundary for terminal-safe crash recovery

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
```

---

### Task 10: Vendor smoke test — `ink-text-input` + `ink-select-input` under Ink 7 / React 19

**Files:**
- Create: `packages/cli/tests/unit/tui/vendor-smoke.test.tsx`

**Interfaces:**
- Consumes: the dependencies from Task 1. Produces no source — this is a **risk-retiring test** proving the two community inputs render and accept stdin under Ink 7 / React 19 (their peer ranges only declare Ink ≥5 / React ≥18). If this fails, the de-risk outcome is "build custom equivalents" — record that in `LEARNINGS.md` (issue #1549).

This task is test-only (no impl commit). It is exempt from the test-before-impl pairing because there is no implementation — but the file is still committed as `test(tui): …`.

- [ ] **Step 1: Write the smoke test**

```tsx
// packages/cli/tests/unit/tui/vendor-smoke.test.tsx
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

describe("vendor inputs under Ink 7 / React 19", () => {
  it("ink-text-input renders and reports typed changes", async () => {
    let value = "";
    function Harness(): React.ReactElement {
      const [v, setV] = React.useState("");
      return (
        <TextInput
          value={v}
          onChange={(next) => {
            value = next;
            setV(next);
          }}
        />
      );
    }
    const { stdin, unmount } = render(<Harness />);
    await flush();
    stdin.write("hello");
    await flush();
    expect(value).toBe("hello");
    unmount();
  });

  it("ink-select-input renders items and selects on Enter", async () => {
    let selectedLabel = "";
    const items = [
      { label: "Alpha", value: "a" },
      { label: "Beta", value: "b" },
    ];
    const { stdin, lastFrame, unmount } = render(
      <SelectInput items={items} onSelect={(item) => { selectedLabel = item.label; }} />,
    );
    await flush();
    expect(lastFrame() ?? "").toContain("Alpha");
    stdin.write("\r"); // Enter selects the highlighted (first) item
    await flush();
    expect(selectedLabel).toBe("Alpha");
    unmount();
  });
});
```

- [ ] **Step 2: Run the smoke test**

Run: `cd packages/cli && pnpm exec vitest run tests/unit/tui/vendor-smoke.test.tsx`
Expected: PASS (2 tests). **If it FAILS**, do not patch around it — stop, record the failure mode in `LEARNINGS.md` (and on issue #1549), and flag to the parent that the affected vendor input must be replaced by a custom component in 9.5/9.7.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/tests/unit/tui/vendor-smoke.test.tsx
git commit -m "test(tui): smoke-test ink-text-input/ink-select-input under Ink 7/React 19

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>"
```

---

## Per-PR closeout (every PR above)

- [ ] Rebase on latest `main` (`git fetch origin main && git rebase origin/main`).
- [ ] `cd packages/cli && pnpm exec vitest run tests/unit/tui` — all green.
- [ ] `pnpm --filter @council-ai/cli lint` — zero warnings; `pnpm --filter @council-ai/cli typecheck` — clean.
- [ ] `git log --oneline main..HEAD` — confirm every `test(tui)` precedes its `feat(tui)` (Task 1 & Task 10 excepted: `chore`/test-only).
- [ ] Push branch, open PR, parent invokes Sentinel, merge on APPROVED/CONDITIONAL, then `git worktree remove` + `git branch -D`.

## Self-Review (completed)

- **Spec coverage:** all six de-risk primitives from `docs/designs/interactive-tui.md §6.5` are covered — alt-screen+ErrorBoundary (Task 9; alt-screen flag itself is a one-line Ink render option exercised in 9.2, ErrorBoundary is the risky part), `useMode` (Task 5), `ScrollView` (Tasks 4+6), `MultilineInput` (Task 7), CommandPalette focus (Task 8), non-TTY guard (Task 2), ink-testing harness (used throughout), vendor peer-range validation (Task 10). Deps (Task 1) gate all.
- **Placeholder scan:** no TBD/TODO; every code step has complete, runnable code.
- **Type consistency:** `computeScrollWindow`/`ScrollWindowInput` (Task 4) consumed verbatim by `ScrollView` (Task 6); `fuzzyMatch`/`FuzzyResult` (Task 3) consumed verbatim by `CommandPalette` (Task 8); `Mode`/`ModeAction` (Task 5) names stable.
- **Open follow-ups referenced:** issue #1549 (LEARNINGS.md vendor caveat) is the home for a Task 10 failure.

## Out of scope for M0 (do NOT build here)

Alt-screen wiring into `bin/council.ts`, `MemoryRouter` routing, the `AppShell`/`Header`/`Footer`, semantic color theme, Home dashboard, and the `isInteractive()` call site — all land in milestone **9.2**. M0 only proves the primitives in isolation.
