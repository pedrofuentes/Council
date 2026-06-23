# Council TUI — Milestone 9.3 (M2 Library Browse/Detail + Command Palette) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the TUI navigable and readable — wire `react-router` navigation through the left nav and a command palette, and add read-only **list + detail** screens for **Panels**, **Experts**, and **Sessions** (debate/convene runs), each backed by a unit-tested view-model adapter. All behind `COUNCIL_TUI=1`; the full CLI stays untouched.

**Architecture:** A navigation refactor lifts the app body inside `MemoryRouter` so screens use `useNavigate`/`useLocation`. Each domain gets a **pure, fully-tested adapter** in `src/tui/adapters/*` that maps repositories → flat view-models (the "thin entry glue / tested adapter" rule from M1's PR #1585). Screens are thin Ink components that receive a loader through a `DataContext` and render loading/empty/loaded/error states; a reusable `useListSelection` hook + `SelectableList` give every list `j/k`/arrows/`Enter` behavior. `launchTui` stays thin glue: it builds the adapters from real repos and provides them.

**Tech Stack:** TypeScript ESM, Ink 7 (`useInput`, `useApp`, `Box`/`Text`), React 19 (Context + `useState`/`useEffect`), `react-router` (`MemoryRouter`, `Routes`/`Route`, `useNavigate`, `useLocation`, `useParams`), Vitest + `ink-testing-library`. All deps already on `main`.

## Global Constraints

Copied verbatim from `docs/designs/interactive-tui.md`, `AGENTS.md`, repo config, and `LEARNINGS.md` — every task implicitly includes these:

- **Runtime:** Node ≥ 24; ESM. **Import specifiers end in `.js`** even for `.ts`/`.tsx` sources.
- **JSX:** classic runtime — every `.tsx` starts with `import React from "react";`.
- **Exports:** named exports only (no `default`). Explicit return types on exported functions/components. `interface` for object shapes. `readonly` by default. **No `any`** (use `unknown` + guards).
- **TDD ordering (Sentinel-enforced):** the `test(tui): …` commit MUST precede the `feat(tui): …` commit for behavior-bearing code; never combine them. Demonstrate RED.
- **⚠️ LEARNINGS that caused M0/M1 Sentinel rejections — apply to EVERY task:**
  1. **Entry files are thin glue only.** Data-mapping / wiring / decision logic lives in a tested `.ts` adapter, NOT in `index.tsx`/screens/`bin`. (`.tsx` and `src/bin/**` are outside the coverage gate — logic there is unmeasured. PR #1585.)
  2. **Test the exported component/hook behavior, not just a pure helper.** Render via `ink-testing-library`; assert frames/callbacks. Cover EVERY keyboard branch you implement (each arrow, `Enter`, `Esc`, typing). Partial coverage is rejected 🔴.
  3. **A lone `Esc` (`\u001b`) needs a REAL timer wait** in tests (`await new Promise(r => setTimeout(r, 120))`), NOT `setImmediate` `flush()` — Ink buffers it behind a real-time disambiguation timeout. Complete sequences (arrows `\u001b[A`/`\u001b[B`, `Tab` `\t`, `Enter` `\r`) are delivered immediately and work with `flush()`.
  4. **Sanitize EVERY untrusted string before the terminal `<Text>` sink** — `toSingleLineDisplay` (single-line: names, slugs, roles, titles, status, summaries) or `stripControlChars` (multi-line: transcript turn content). Untrusted = anything from config, the DB (panel/expert/session names, summaries), YAML, or models. Audit **every** sink, not one. From `packages/cli/src/cli/strip-control-chars.js`.
- **Coverage gate (Sentinel targeted run):** statements 90 / branches 75 / functions 90 / lines 90 on changed `.ts` files. Every adapter function + branch must be exercised. `.tsx` screens are not coverage-measured but ARE reviewed for untested logic — keep logic out of them.
- **`@github/copilot-sdk` boundary:** never import it outside `engine/copilot/adapter.ts`. M2 touches no engine code.
- **Per increment:** git worktree off `main` (never commit on `main`); `pnpm install --frozen-lockfile` in each fresh worktree; run `pnpm --filter @council-ai/cli test` + `lint` + `typecheck` before pushing; open a PR; the PARENT invokes Sentinel; merge only on APPROVED/CONDITIONAL. **Delegated implementers stop after opening the PR** and report PR URL + HEAD SHA.
- **Test color:** `tests/setup.ts` forces `FORCE_COLOR=3`, so Ink emits SGR (`\u001b[7m` for `inverse`, color codes for `chalk`) — assert against them for highlight/active state.
- **Test location:** `packages/cli/tests/unit/tui/…`. Single file: `cd packages/cli && pnpm exec vitest run tests/unit/tui/<file>`.

## Data Model — verified seams (source of truth for adapters)

Confirmed against `main` 2026-06-23. Adapters consume these; screens never call repos directly.

**Panels**
- `PanelLibraryRepository` (`src/memory/repositories/panel-library-repo.ts`): `findAll(): Promise<readonly LibraryPanel[]>` where `LibraryPanel = { name: string; description: string | null; yamlPath: string; yamlChecksum: string; createdAt: string; updatedAt: string }`; `getMembers(panelName: string): Promise<readonly string[]>` (ordered expert **slugs**).
- Built-in templates (`src/core/template-loader.ts`): `listTemplates(): Promise<readonly string[]>` (17 names); `loadTemplate(name): Promise<ResolvedPanelDefinition>` where `ResolvedPanelDefinition = { name: string; description?: string; defaults?: { mode?: "freeform"|"structured"; maxRounds?: number; model?: string }; experts: readonly ExpertDefinition[] }`.
- Member resolution (saved panels): `ExpertLibrary.get(slug): Promise<ExpertDefinition | null>` → `displayName`, `role`, `kind`.

**Experts**
- `ExpertLibrary` (`src/core/expert-library.ts`, impl `FileExpertLibrary`): `list(): Promise<readonly ExpertDefinition[]>`; `get(slug): Promise<ExpertDefinition | null>`; `panelsFor(slug): Promise<readonly string[]>`.
- `ExpertDefinition` (`src/core/expert.ts`): `{ slug; displayName; role; model?; expertise: { weightedEvidence: string[]; referenceCases: string[]; notExpertIn: string[] }; epistemicStance; debateProtocol?; outputContract?; forbiddenMoves?; personality?; kind: "generic"|"persona"; personaDescription?; docsPath? }`.

**Sessions = debate/convene runs** (what `council sessions` lists; `src/cli/commands/sessions.ts`)
- `PanelRepository.findAll(): Promise<readonly Panel[]>` where `Panel = { id; name; topic: string | null; copilotHome; configJson; createdAt; updatedAt }`.
- `DebateRepository.findByPanelId(panelId): Promise<readonly Debate[]>` where `Debate = { id; panelId; prompt; status: "running"|"completed"|"interrupted"|"aborted"|"failed"; moderator; startedAt; endedAt: string | null; costEstimate: number | null }`.
- `TurnRepository.countByDebateId(debateId): Promise<number>`; `findLatestByDebateId(debateId): Promise<Turn | undefined>`.
- Detail transcript: `loadTranscript(db, panelName, debateId?): Promise<TranscriptDocument>` → `{ panel: Panel; experts: readonly Expert[]; originalPrompt: string; latestDebate: { id; prompt; status; startedAt; endedAt }; turns: readonly Turn[] }`; `Turn = { id; debateId; round; seq; speakerKind: "user"|"expert"|"moderator"|"system"|"human"; expertId: string | null; content; tokensIn; tokensOut; latencyMs; createdAt }`.
- **⚠️ Status truth:** conclusions are **NOT persisted** (no conclusions table; `conclude` writes to stdout only). The honest, persisted status is **`debate.status`**. The Sessions screen shows `debate.status` — it MUST NOT invent a "concluded" flag. (The Home screen's archived→"concluded" mapping is a separate chat-session concern tracked by #1582; do not extend it here.)

**Sanitizers:** `toSingleLineDisplay`, `stripControlChars` from `packages/cli/src/cli/strip-control-chars.js`.

## PR / worktree grouping (7 PRs)

| PR | Branch | Tasks | Dep |
|----|--------|-------|-----|
| PR-A | `feature/tui-nav-foundation` | Task 1 (`useListSelection` + `SelectableList`), Task 2 (router refactor: `AppRouter` inside `MemoryRouter`, `useLocation`/`useNavigate`, LeftNav wired, detail routes, `PlaceholderScreen`) | M1 |
| PR-B | `feature/tui-panels` | Task 3 (`panels-data` adapter), Task 4 (`DataContext`), Task 5 (`PanelsScreen` list) | PR-A |
| PR-C | `feature/tui-panel-detail` | Task 6 (`panels-data` `loadDetail`), Task 7 (`PanelDetailScreen` + Enter→detail) | PR-B |
| PR-D | `feature/tui-experts` | Task 8 (`experts-data` adapter), Task 9 (`ExpertsScreen` list), Task 10 (`ExpertDetailScreen`) | PR-B |
| PR-E | `feature/tui-sessions` | Task 11 (`sessions-data` adapter), Task 12 (`SessionsScreen` list) | PR-B |
| PR-F | `feature/tui-session-detail` | Task 13 (`sessions-data` `loadTranscript` adapter), Task 14 (`SessionDetailScreen` + Enter→detail) | PR-E |
| PR-G | `feature/tui-command-palette` | Task 15 (`palette-commands` builder), Task 16 (wire `CommandPalette` to `Ctrl-K` + navigation) | PR-A (PR-B..F for contextual commands) |

PR-B..PR-G each rebase on latest `main` after the prior merges. PR-D and PR-E are independent of each other (both depend on PR-B's `DataContext`) and may run in parallel.

## File Structure

```
packages/cli/src/tui/
  hooks/
    use-list-selection.ts     useListSelection({count,isActive,onActivate}) → {cursor,...} (NEW)
  components/
    lists/
      SelectableList.tsx       windowed selectable list over ScrollView + useListSelection (NEW)
    DataProvider.tsx           DataContext + useData() — provides domain loaders to screens (NEW)
  router/
    routes.ts                  add detail routes (MODIFY)
    AppRouter.tsx              app body inside MemoryRouter: layout + Routes + nav + key handling (NEW)
  screens/
    PlaceholderScreen.tsx      generic "nothing here yet" route stub (NEW, PR-A)
    PanelsScreen.tsx           panels list (NEW, PR-B)
    PanelDetailScreen.tsx      one panel's members/defaults (NEW, PR-C)
    ExpertsScreen.tsx          experts list (NEW, PR-D)
    ExpertDetailScreen.tsx     one expert's definition (NEW, PR-D)
    SessionsScreen.tsx         debate-run list (NEW, PR-E)
    SessionDetailScreen.tsx    one run's transcript (NEW, PR-F)
  adapters/
    panels-data.ts             createPanelsDataSource(deps) → {loadList,loadDetail} (NEW)
    experts-data.ts            createExpertsDataSource(deps) → {loadList,loadDetail} (NEW)
    sessions-data.ts           createSessionsDataSource(deps) → {loadList,loadTranscript} (NEW)
    palette-commands.ts        buildPaletteCommands(context) → PaletteCommand[] (NEW, PR-G)
  CouncilTUI.tsx               render <MemoryRouter><AppRouter/></MemoryRouter> (MODIFY, PR-A)
  index.tsx                    build adapters from repos; pass via <DataProvider> (MODIFY thin glue, PR-B+)
```

---

## Task 1: `useListSelection` hook + `SelectableList` component

**Files:**
- Create: `packages/cli/src/tui/hooks/use-list-selection.ts`
- Create: `packages/cli/src/tui/components/lists/SelectableList.tsx`
- Test: `packages/cli/tests/unit/tui/use-list-selection.test.tsx`, `packages/cli/tests/unit/tui/selectable-list.test.tsx`

**Interfaces:**
- Produces:
  - `useListSelection(opts: { count: number; isActive?: boolean; onActivate?: (index: number) => void }): { cursor: number }` — owns cursor state; `j`/`↓` → +1 (clamped at `count-1`), `k`/`↑` → −1 (clamped at 0), `g` → 0, `G` → `count-1`, `Enter` → `onActivate(cursor)`. No-ops when `count===0` or `isActive===false`.
  - `SelectableList(props: { items: readonly string[]; isActive?: boolean; onActivate?: (index: number) => void; height?: number }): React.ReactElement` — renders the windowed list with the active row inverted; composes `useListSelection` + `ScrollView`.

- [ ] **Step 1: Write the failing hook test** (`use-list-selection.test.tsx`)

```tsx
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { describe, expect, it, vi } from "vitest";

import { useListSelection } from "../../../src/tui/hooks/use-list-selection.js";

function Harness(props: { count: number; onActivate?: (i: number) => void; isActive?: boolean }): React.ReactElement {
  const { cursor } = useListSelection({ count: props.count, onActivate: props.onActivate, isActive: props.isActive });
  return <Text>cursor={cursor}</Text>;
}

const flush = async (stdin: { write: (s: string) => void } | undefined, s: string): Promise<void> => {
  stdin?.write(s);
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

describe("useListSelection", () => {
  it("moves down with j and arrow, clamped at count-1", async () => {
    const { stdin, lastFrame } = render(<Harness count={3} />);
    await flush(stdin, "j");
    expect(lastFrame()).toContain("cursor=1");
    await flush(stdin, "\u001b[B"); // down arrow
    expect(lastFrame()).toContain("cursor=2");
    await flush(stdin, "j"); // clamp
    expect(lastFrame()).toContain("cursor=2");
  });

  it("moves up with k, clamped at 0; g/G jump to ends", async () => {
    const { stdin, lastFrame } = render(<Harness count={3} />);
    await flush(stdin, "G");
    expect(lastFrame()).toContain("cursor=2");
    await flush(stdin, "k");
    expect(lastFrame()).toContain("cursor=1");
    await flush(stdin, "g");
    expect(lastFrame()).toContain("cursor=0");
    await flush(stdin, "k"); // clamp
    expect(lastFrame()).toContain("cursor=0");
  });

  it("fires onActivate(cursor) on Enter", async () => {
    const onActivate = vi.fn();
    const { stdin } = render(<Harness count={3} onActivate={onActivate} />);
    await flush(stdin, "j");
    await flush(stdin, "\r");
    expect(onActivate).toHaveBeenCalledWith(1);
  });

  it("is inert when count===0 or isActive===false", async () => {
    const onActivate = vi.fn();
    const a = render(<Harness count={0} onActivate={onActivate} />);
    await flush(a.stdin, "j");
    await flush(a.stdin, "\r");
    expect(a.lastFrame()).toContain("cursor=0");
    expect(onActivate).not.toHaveBeenCalled();
    const b = render(<Harness count={3} onActivate={onActivate} isActive={false} />);
    await flush(b.stdin, "j");
    expect(b.lastFrame()).toContain("cursor=0");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`use-list-selection.js` missing). Commit tests only:
`git commit -m "test(tui): add failing tests for useListSelection hook"` (+ trailer).

- [ ] **Step 3: Implement the hook**

```ts
import { useState } from "react";
import { useInput } from "ink";

export interface UseListSelectionOptions {
  readonly count: number;
  readonly isActive?: boolean;
  readonly onActivate?: (index: number) => void;
}

export function useListSelection(opts: UseListSelectionOptions): { readonly cursor: number } {
  const isActive = opts.isActive ?? true;
  const [cursor, setCursor] = useState(0);
  const last = Math.max(0, opts.count - 1);

  useInput(
    (input, key) => {
      if (opts.count === 0) return;
      if (input === "j" || key.downArrow) {
        setCursor((c) => Math.min(last, c + 1));
      } else if (input === "k" || key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
      } else if (input === "g") {
        setCursor(0);
      } else if (input === "G") {
        setCursor(last);
      } else if (key.return) {
        opts.onActivate?.(Math.min(cursor, last));
      }
    },
    { isActive },
  );

  return { cursor: Math.min(cursor, last) };
}
```

- [ ] **Step 4: Run hook test — expect PASS.** Commit: `feat(tui): add useListSelection hook` (+ trailer).

- [ ] **Step 5: Write the failing `SelectableList` test** (`selectable-list.test.tsx`)

```tsx
import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { SelectableList } from "../../../src/tui/components/lists/SelectableList.js";

const flush = async (stdin: { write: (s: string) => void } | undefined, s: string): Promise<void> => {
  stdin?.write(s);
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

describe("SelectableList", () => {
  it("inverts the active row and moves the cursor", async () => {
    const { stdin, lastFrame } = render(<SelectableList items={["Alpha", "Beta", "Gamma"]} height={5} />);
    expect(lastFrame()).toContain("\u001b[7mAlpha"); // row 0 inverse
    await flush(stdin, "j");
    expect(lastFrame()).toContain("\u001b[7mBeta");
  });

  it("activates the focused item on Enter with its index", async () => {
    const onActivate = vi.fn();
    const { stdin } = render(<SelectableList items={["Alpha", "Beta"]} onActivate={onActivate} />);
    await flush(stdin, "j");
    await flush(stdin, "\r");
    expect(onActivate).toHaveBeenCalledWith(1);
  });

  it("renders an empty list without crashing and ignores input", async () => {
    const onActivate = vi.fn();
    const { stdin, lastFrame } = render(<SelectableList items={[]} onActivate={onActivate} />);
    await flush(stdin, "\r");
    expect(onActivate).not.toHaveBeenCalled();
    expect(lastFrame()).toBeDefined();
  });
});
```

- [ ] **Step 6: Run — expect FAIL.** Commit: `test(tui): add failing tests for SelectableList` (+ trailer).

- [ ] **Step 7: Implement `SelectableList`**

```tsx
import React from "react";

import { useListSelection } from "../../hooks/use-list-selection.js";
import { ScrollView } from "./ScrollView.js";

export interface SelectableListProps {
  readonly items: readonly string[];
  readonly isActive?: boolean;
  readonly onActivate?: (index: number) => void;
  readonly height?: number;
}

export function SelectableList(props: SelectableListProps): React.ReactElement {
  const { cursor } = useListSelection({
    count: props.items.length,
    isActive: props.isActive,
    onActivate: props.onActivate,
  });
  return <ScrollView items={props.items} height={props.height ?? props.items.length} cursor={cursor} />;
}
```

- [ ] **Step 8: Run — expect PASS.** `pnpm exec vitest run tests/unit/tui/use-list-selection.test.tsx tests/unit/tui/selectable-list.test.tsx`. Commit: `feat(tui): add SelectableList component` (+ trailer).

---

## Task 2: Router refactor — `AppRouter` inside `MemoryRouter`

**Why:** `useNavigate`/`useLocation` must run inside the router. Today `CouncilTUI`'s `useInput` and `activeRoute` sit outside `<MemoryRouter>`, so nav can't be wired. Lift the body into `AppRouter` rendered inside the router; derive the active nav id + breadcrumb from `useLocation`; wire `LeftNav.onSelect` to `useNavigate`; add detail routes; render per-route elements (Home real; others a `PlaceholderScreen` until their PR lands).

**Files:**
- Create: `packages/cli/src/tui/screens/PlaceholderScreen.tsx`
- Create: `packages/cli/src/tui/router/AppRouter.tsx`
- Modify: `packages/cli/src/tui/router/routes.ts`
- Modify: `packages/cli/src/tui/CouncilTUI.tsx`
- Test: `packages/cli/tests/unit/tui/placeholder-screen.test.tsx`, `packages/cli/tests/unit/tui/app-router.test.tsx`; update `packages/cli/tests/unit/tui/council-tui.test.tsx`

**Interfaces:**
- Consumes: `computeLayout` (`lib/breakpoints.js`), `resolveTheme` (`theme/tokens.js`), `AppShell`/`Header`/`Footer`/`LeftNav`, `HelpModal`, `HomeScreen`, `ROUTES`.
- Produces:
  - `ROUTES` adds: `panelDetail: "/panels/:name"`, `expertDetail: "/experts/:slug"`, `sessionDetail: "/sessions/:id"`.
  - `routeToNavId(pathname: string): string` (exported pure helper in `routes.ts`) — maps a pathname to a nav id (`/` → `home`; `/panels` or `/panels/x` → `panels`; etc.).
  - `PlaceholderScreen({ title, theme }): React.ReactElement`.
  - `AppRouter(props: CouncilTUIProps): React.ReactElement` — the former `CouncilTUI` body, now using `useLocation`/`useNavigate`.

- [ ] **Step 1: Failing test for `routeToNavId`** (add to `app-router.test.tsx` or a `routes.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { routeToNavId } from "../../../src/tui/router/routes.js";

describe("routeToNavId", () => {
  it("maps list and detail paths to the nav id", () => {
    expect(routeToNavId("/")).toBe("home");
    expect(routeToNavId("/panels")).toBe("panels");
    expect(routeToNavId("/panels/acme")).toBe("panels");
    expect(routeToNavId("/experts/cto")).toBe("experts");
    expect(routeToNavId("/sessions/abc")).toBe("sessions");
    expect(routeToNavId("/settings")).toBe("settings");
  });
  it("falls back to home for unknown paths", () => {
    expect(routeToNavId("/nope")).toBe("home");
  });
});
```

- [ ] **Step 2: Failing test for navigation behavior** (`app-router.test.tsx`) — render `CouncilTUI` (which renders `AppRouter`), assert that pressing the palette/nav path changes the rendered screen. Since LeftNav selection is mouseless, drive nav via the **command palette is out of scope here**; instead test `AppRouter` by asserting that visiting a detail route renders its placeholder and that the breadcrumb reflects `useLocation`. Use `MemoryRouter` `initialEntries` via a thin test wrapper:

```tsx
import React from "react";
import { render } from "ink-testing-library";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { AppRouter } from "../../../src/tui/router/AppRouter.js";
import type { HomeData } from "../../../src/tui/adapters/home-data.js";

const homeData: HomeData = { counts: { sessions: 0, experts: 0, panels: 0 }, recent: [] };

describe("AppRouter", () => {
  it("renders the Panels placeholder on the /panels route with a Panels breadcrumb", () => {
    const { lastFrame } = render(
      <MemoryRouter initialEntries={["/panels"]}>
        <AppRouter homeData={homeData} model="gpt-4o" initialColumns={120} initialRows={30} />
      </MemoryRouter>,
    );
    expect(lastFrame()).toContain("Panels");
  });
});
```

(Keep `CouncilTUI`'s own tests green by updating them to the new structure where needed; `CouncilTUI` now just wraps `AppRouter` in `MemoryRouter`.)

- [ ] **Step 3: Run — expect FAIL.** Commit tests: `test(tui): add failing tests for router refactor + routeToNavId` (+ trailer).

- [ ] **Step 4: Implement.** Add to `routes.ts`:

```ts
export const ROUTES = {
  home: "/",
  panels: "/panels",
  panelDetail: "/panels/:name",
  experts: "/experts",
  expertDetail: "/experts/:slug",
  sessions: "/sessions",
  sessionDetail: "/sessions/:id",
  chats: "/chats",
  settings: "/settings",
} as const;

const NAV_PREFIXES: readonly { readonly prefix: string; readonly id: string }[] = [
  { prefix: "/panels", id: "panels" },
  { prefix: "/experts", id: "experts" },
  { prefix: "/sessions", id: "sessions" },
  { prefix: "/chats", id: "chats" },
  { prefix: "/settings", id: "settings" },
];

export function routeToNavId(pathname: string): string {
  for (const { prefix, id } of NAV_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return id;
  }
  return "home";
}
```

`PlaceholderScreen.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { SemanticTheme } from "../theme/tokens.js";

export interface PlaceholderScreenProps {
  readonly title: string;
  readonly theme: SemanticTheme;
}

export function PlaceholderScreen(props: PlaceholderScreenProps): React.ReactElement {
  return (
    <Box height="100%" alignItems="center" justifyContent="center" flexDirection="column">
      <Text>{props.theme.accent(toSingleLineDisplay(props.title))}</Text>
      <Text>{props.theme.muted("Coming soon")}</Text>
    </Box>
  );
}
```

`AppRouter.tsx` — move the current `CouncilTUI` body here, with these changes: take `useLocation()` → `const navId = routeToNavId(location.pathname)` (replaces the hardcoded `activeRoute`); take `useNavigate()`; set `LeftNav.onSelect={(id) => navigate(navId-to-path)}` using a small `navIdToRoute` map; set the `Header` breadcrumb to the human label for `navId`; render `<Routes>` with Home real and the others `<PlaceholderScreen>`:

```tsx
<Routes>
  <Route path={ROUTES.home} element={<HomeScreen data={props.homeData} theme={theme} />} />
  <Route path={ROUTES.panels} element={<PlaceholderScreen title="Panels" theme={theme} />} />
  <Route path={ROUTES.experts} element={<PlaceholderScreen title="Experts" theme={theme} />} />
  <Route path={ROUTES.sessions} element={<PlaceholderScreen title="Sessions" theme={theme} />} />
  <Route path={ROUTES.settings} element={<PlaceholderScreen title="Settings" theme={theme} />} />
</Routes>
```

`CouncilTUI.tsx` shrinks to:

```tsx
export function CouncilTUI(props: CouncilTUIProps): React.ReactElement {
  return (
    <MemoryRouter initialEntries={[ROUTES.home]}>
      <AppRouter {...props} />
    </MemoryRouter>
  );
}
```

Keep `CouncilTUIProps` where it is (or re-export from `AppRouter`). LeftNav `onSelect` wiring:

```ts
const NAV_ID_TO_ROUTE: Record<string, string> = {
  home: ROUTES.home, panels: ROUTES.panels, experts: ROUTES.experts,
  sessions: ROUTES.sessions, chats: ROUTES.chats, settings: ROUTES.settings,
};
// onSelect={(id) => navigate(NAV_ID_TO_ROUTE[id] ?? ROUTES.home)}
```

- [ ] **Step 5: Run all tui tests — expect PASS.** `pnpm exec vitest run tests/unit/tui`. Fix any `council-tui.test.tsx` assertions that referenced the old internal structure. Commit: `feat(tui): lift app body into AppRouter for routed navigation` (+ trailer).

> Note: `LeftNav` keyboard selection (focusing the nav and pressing Enter to navigate) may already be exercised by existing `left-nav.test.tsx`. If `LeftNav` has no internal key handling to choose an item, wiring `onSelect` to navigation is still meaningful via the palette (PR-G) and via future focus work; for M2 the **command palette is the primary navigation** and `routeToNavId` keeps the nav highlight correct. Do not add unused handlers.

---

## Task 3: `panels-data` adapter — `loadList`

**Files:**
- Create: `packages/cli/src/tui/adapters/panels-data.ts`
- Test: `packages/cli/tests/unit/tui/panels-data.test.ts`

**Interfaces:**
- Produces:

```ts
export interface PanelListItem {
  readonly name: string;
  readonly description: string;        // "" when null
  readonly memberCount: number;
  readonly source: "saved" | "template";
}
export interface PanelsRepos {
  readonly library: { findAll(): Promise<readonly { readonly name: string; readonly description: string | null }[]>;
                      getMembers(name: string): Promise<readonly string[]> };
  readonly listTemplates: () => Promise<readonly string[]>;
  readonly loadTemplate: (name: string) => Promise<{ readonly description?: string; readonly experts: readonly unknown[] }>;
}
export interface PanelsDataSource {
  readonly loadList: () => Promise<readonly PanelListItem[]>;
  // loadDetail added in Task 6
}
export function createPanelsDataSource(repos: PanelsRepos): PanelsDataSource;
```

`loadList` returns saved panels first (each: `getMembers(name).length`), then built-in templates (each: `loadTemplate(name)` → `experts.length`, description). Sanitization happens in the **screen**, not the adapter (adapters return raw view-models; screens sanitize at the `<Text>` sink).

- [ ] **Step 1: Failing test** (`panels-data.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { createPanelsDataSource } from "../../../src/tui/adapters/panels-data.js";

describe("createPanelsDataSource.loadList", () => {
  it("lists saved panels then templates with member counts", async () => {
    const ds = createPanelsDataSource({
      library: {
        findAll: async () => [{ name: "acme", description: "Exec panel" }, { name: "bare", description: null }],
        getMembers: async (n) => (n === "acme" ? ["cto", "cfo"] : []),
      },
      listTemplates: async () => ["startup-board"],
      loadTemplate: async (n) => ({ description: `tpl ${n}`, experts: [{}, {}, {}] }),
    });
    const list = await ds.loadList();
    expect(list).toEqual([
      { name: "acme", description: "Exec panel", memberCount: 2, source: "saved" },
      { name: "bare", description: "", memberCount: 0, source: "saved" },
      { name: "startup-board", description: "tpl startup-board", memberCount: 3, source: "template" },
    ]);
  });

  it("returns an empty array when there are no panels or templates", async () => {
    const ds = createPanelsDataSource({
      library: { findAll: async () => [], getMembers: async () => [] },
      listTemplates: async () => [],
      loadTemplate: async () => ({ experts: [] }),
    });
    expect(await ds.loadList()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Commit: `test(tui): add failing tests for panels-data loadList` (+ trailer).
- [ ] **Step 3: Implement** `createPanelsDataSource` with `loadList` (map saved via `getMembers`, templates via `loadTemplate`; `description: d ?? ""`).
- [ ] **Step 4: Run — expect PASS.** Commit: `feat(tui): add panels-data adapter loadList` (+ trailer).

---

## Task 4: `DataContext` provider

**Files:**
- Create: `packages/cli/src/tui/components/DataProvider.tsx`
- Test: `packages/cli/tests/unit/tui/data-provider.test.tsx`

**Interfaces:**
- Produces:

```ts
export interface TuiDataSources {
  readonly panels: PanelsDataSource;
  // experts, sessions added by their PRs (optional until then)
  readonly experts?: ExpertsDataSource;
  readonly sessions?: SessionsDataSource;
}
export function DataProvider(props: { value: TuiDataSources; children: React.ReactNode }): React.ReactElement;
export function useData(): TuiDataSources;   // throws if used outside a provider
```

- [ ] **Step 1: Failing test** — render a tiny consumer that calls `useData()` inside `DataProvider` and asserts it returns the provided value; assert `useData()` **throws** when rendered without a provider (wrap in an `ErrorBoundary` or assert via `render` stderr). Example:

```tsx
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { describe, expect, it } from "vitest";
import { DataProvider, useData } from "../../../src/tui/components/DataProvider.js";

function Consumer(): React.ReactElement {
  const data = useData();
  return <Text>panels={String(Boolean(data.panels))}</Text>;
}

describe("DataProvider", () => {
  it("provides the value to useData", () => {
    const value = { panels: { loadList: async () => [] } } as never;
    const { lastFrame } = render(<DataProvider value={value}><Consumer /></DataProvider>);
    expect(lastFrame()).toContain("panels=true");
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Commit: `test(tui): add failing tests for DataProvider` (+ trailer).
- [ ] **Step 3: Implement** with `React.createContext<TuiDataSources | null>(null)`, `useData` throwing `"useData must be used within a DataProvider"` on `null`.
- [ ] **Step 4: Run — expect PASS.** Commit: `feat(tui): add DataProvider context` (+ trailer).

---

## Task 5: `PanelsScreen` (list) + route wiring + `index.tsx` glue

**Files:**
- Create: `packages/cli/src/tui/screens/PanelsScreen.tsx`
- Modify: `packages/cli/src/tui/router/AppRouter.tsx` (swap the panels `PlaceholderScreen` for `PanelsScreen`)
- Modify: `packages/cli/src/tui/index.tsx` (build `panels-data` from real repos; wrap `<CouncilTUI>` in `<DataProvider>`)
- Modify: `packages/cli/src/tui/CouncilTUI.tsx` / `AppRouter.tsx` to accept that screens read data via `useData()`
- Test: `packages/cli/tests/unit/tui/panels-screen.test.tsx`

**Screen behavior:** on mount, call `useData().panels.loadList()` in `useEffect`; states: `loading` → spinner/"Loading panels…"; `loaded & empty` → empty CTA ("No panels yet — create one with `c`"); `loaded` → `SelectableList` of `"<name>  <memberCount> experts  <description>"` (each field via `toSingleLineDisplay`); `error` → `theme.error("Failed to load panels")`. `isActive` gates the list (false while help/palette open — pass through from `AppRouter` mode).

- [ ] **Step 1: Failing test** (`panels-screen.test.tsx`) — render with a fake `DataProvider` value whose `panels.loadList` resolves to 2 items; flush; assert both names render and row 0 is inverse. Add an empty-state test (resolves `[]`) and an error-state test (rejects).

```tsx
import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { DataProvider } from "../../../src/tui/components/DataProvider.js";
import { PanelsScreen } from "../../../src/tui/screens/PanelsScreen.js";
import { resolveTheme } from "../../../src/tui/theme/tokens.js";

const theme = resolveTheme({});
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };

const withPanels = (loadList: () => Promise<readonly unknown[]>) =>
  ({ panels: { loadList } }) as never;

describe("PanelsScreen", () => {
  it("renders the loaded panels", async () => {
    const { lastFrame } = render(
      <DataProvider value={withPanels(async () => [
        { name: "acme", description: "Exec", memberCount: 2, source: "saved" },
        { name: "startup-board", description: "tpl", memberCount: 3, source: "template" },
      ])}>
        <PanelsScreen theme={theme} isActive />
      </DataProvider>,
    );
    await flush();
    expect(lastFrame()).toContain("acme");
    expect(lastFrame()).toContain("startup-board");
  });

  it("shows an empty state when there are no panels", async () => {
    const { lastFrame } = render(
      <DataProvider value={withPanels(async () => [])}><PanelsScreen theme={theme} isActive /></DataProvider>,
    );
    await flush();
    expect(lastFrame()).toMatch(/No panels/i);
  });

  it("shows an error state when loading fails", async () => {
    const { lastFrame } = render(
      <DataProvider value={withPanels(async () => { throw new Error("boom"); })}><PanelsScreen theme={theme} isActive /></DataProvider>,
    );
    await flush();
    expect(lastFrame()).toMatch(/Failed to load panels/i);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** Commit: `test(tui): add failing tests for PanelsScreen` (+ trailer).
- [ ] **Step 3: Implement `PanelsScreen`** (a `useAsyncData` inline pattern; keep mapping minimal — formatting a row string is presentation, allowed in the screen, but the data shaping stays in the adapter). Swap the route element in `AppRouter`. Update `index.tsx` (thin glue):

```tsx
// index.tsx — build adapters from real repos, provide them
import { createPanelsDataSource } from "./adapters/panels-data.js";
import { listTemplates, loadTemplate } from "../core/template-loader.js";
import { DataProvider } from "./components/DataProvider.js";
// ... inside launchTui, after creating db + repos:
const panelLibraryRepo = new PanelLibraryRepository(db);
const expertLibrary = new FileExpertLibrary(/* dataHome */);
const dataSources = {
  panels: createPanelsDataSource({
    library: panelLibraryRepo,
    listTemplates,
    loadTemplate: (n) => loadTemplate(n),
  }),
};
// render(<ErrorBoundary><DataProvider value={dataSources}><CouncilTUI .../></DataProvider></ErrorBoundary>, ...)
```

(Verify `FileExpertLibrary`'s constructor args against `src/core/expert-library.ts`; pass the resolved data home. If construction is non-trivial, extract a `buildDataSources(db, dataHome)` factory in a tested `.ts` so `index.tsx` stays glue.)

- [ ] **Step 4: Run — expect PASS.** `pnpm exec vitest run tests/unit/tui`. Commit: `feat(tui): add PanelsScreen wired to panels-data` (+ trailer).

> **Reuse note:** the loading/empty/error `useEffect` pattern recurs in every list/detail screen. Extract a tiny tested hook `useAsyncResource<T>(loader): { status; data?; error? }` in `hooks/use-async-resource.ts` **in this task** (test-first) and reuse it in Tasks 7/9/10/12/14 to avoid duplicated untested async glue. Test it directly (resolve → data; reject → error).

---

## Task 6: `panels-data.loadDetail`

**Files:** Modify `panels-data.ts`; extend `panels-data.test.ts`.

**Interfaces — Produces:**

```ts
export interface PanelMemberView { readonly slug: string; readonly displayName: string; readonly role: string; readonly kind: "generic" | "persona"; }
export interface PanelDetailView {
  readonly name: string;
  readonly description: string;
  readonly source: "saved" | "template";
  readonly defaults?: { readonly mode?: string; readonly maxRounds?: number; readonly model?: string };
  readonly members: readonly PanelMemberView[];
  readonly missing: readonly string[];   // member slugs that no longer resolve
}
// on PanelsDataSource:
readonly loadDetail: (name: string, source: "saved" | "template") => Promise<PanelDetailView | undefined>;
```

`loadDetail`:
- `source==="saved"`: `library.findAll()` to find the row (name+description) or add a `findByName` to `PanelsRepos`; `getMembers(name)` → for each slug `experts.get(slug)`; resolved → `PanelMemberView`, unresolved → push to `missing`. Add `experts.get` to `PanelsRepos`. `defaults` left undefined for saved in M2 (YAML parsing deferred) **or** read from `loadTemplate` only for templates.
- `source==="template"`: `loadTemplate(name)` → `description`, `defaults`, `experts` (already `ExpertDefinition[]`) → map to `PanelMemberView`; `missing: []`.

- [ ] Test-first: a saved panel with one resolvable + one missing member; a template panel with defaults + members. Then implement. Commit `test(tui):` then `feat(tui):` per choreography.

---

## Task 7: `PanelDetailScreen` + Enter→detail wiring

**Files:**
- Create: `packages/cli/src/tui/screens/PanelDetailScreen.tsx`
- Modify: `AppRouter.tsx` (add the `ROUTES.panelDetail` route); `PanelsScreen.tsx` (`onActivate` → `navigate(/panels/<name>?source=...)` — or store the selected item and navigate by name; pass `source` via the route state or a query). Simplest: navigate to `/panels/${encodeURIComponent(name)}` and have the detail screen try saved first, then template, OR carry `source` in router state.
- Test: `packages/cli/tests/unit/tui/panel-detail-screen.test.tsx`

**Behavior:** read `:name` via `useParams`; `useData().panels.loadDetail(name, source)`; render description, defaults (mode/rounds/model if present), and a member list (`slug — displayName · role [kind]`, each sanitized); show `missing` members in `theme.warn`. `Esc` → `navigate(-1)` (back to list). Loading/error/empty(not found) states.

- [ ] Test-first: render inside `MemoryRouter initialEntries={["/panels/acme"]}` + `DataProvider` with a fake `loadDetail` resolving a 2-member view; flush; assert member names + defaults render. Add not-found (resolves `undefined` → "Panel not found") + Esc-goes-back (assert `navigate(-1)` via a spy or that the list re-renders) tests. Remember the **real-timer Esc wait**. Commit `test(tui):` then `feat(tui):`.

---

## Task 8: `experts-data` adapter

**Files:** Create `packages/cli/src/tui/adapters/experts-data.ts`; Test `packages/cli/tests/unit/tui/experts-data.test.ts`.

**Interfaces — Produces:**

```ts
export interface ExpertListItem { readonly slug: string; readonly displayName: string; readonly role: string; readonly kind: "generic" | "persona"; readonly panelCount: number; }
export interface ExpertDetailView {
  readonly slug: string; readonly displayName: string; readonly role: string; readonly kind: "generic" | "persona";
  readonly model?: string;
  readonly epistemicStance: string;
  readonly expertise: { readonly weightedEvidence: readonly string[]; readonly referenceCases: readonly string[]; readonly notExpertIn: readonly string[] };
  readonly personality?: string;
  readonly personaDescription?: string;
  readonly panels: readonly string[];
}
export interface ExpertsRepos {
  readonly library: {
    list(): Promise<readonly ExpertDefLike[]>;
    get(slug: string): Promise<ExpertDefLike | null>;
    panelsFor(slug: string): Promise<readonly string[]>;
  };
}
export interface ExpertsDataSource {
  readonly loadList: () => Promise<readonly ExpertListItem[]>;
  readonly loadDetail: (slug: string) => Promise<ExpertDetailView | undefined>;
}
export function createExpertsDataSource(repos: ExpertsRepos): ExpertsDataSource;
```

`loadList`: `library.list()` → for each `panelsFor(slug).length`. `loadDetail`: `library.get(slug)` (→ undefined if null) + `panelsFor(slug)`; map only the schema fields above.

- [ ] Test-first (`loadList` counts panels; `loadDetail` present vs null→undefined, including persona fields). Implement. `test(tui):` then `feat(tui):`.

---

## Task 9: `ExpertsScreen` (list)

**Files:** Create `ExpertsScreen.tsx`; modify `AppRouter` (swap placeholder); Test `experts-screen.test.tsx`.
Same shape as `PanelsScreen` using `useAsyncResource` + `useData().experts.loadList()`; rows `"<slug>  <displayName> — <role> [<kind>]  <panelCount> panels"` (sanitized). Empty CTA "No experts yet". `onActivate` → `navigate(/experts/<slug>)`.
- [ ] Test-first (loaded / empty / error), then implement.

---

## Task 10: `ExpertDetailScreen`

**Files:** Create `ExpertDetailScreen.tsx`; modify `AppRouter` (add `ROUTES.expertDetail`); Test `expert-detail-screen.test.tsx`.
`:slug` via `useParams`; `useData().experts.loadDetail(slug)`; render role/kind/model, epistemic stance, expertise lists, optional personality/persona, panels. `Esc` → back. Not-found state.
- [ ] Test-first (renders fields; not-found; Esc back with real-timer wait), then implement.

---

## Task 11: `sessions-data` adapter — `loadList`

**Files:** Create `packages/cli/src/tui/adapters/sessions-data.ts`; Test `sessions-data.test.ts`.

**Interfaces — Produces:**

```ts
export type DebateStatus = "running" | "completed" | "interrupted" | "aborted" | "failed";
export interface SessionListItem {
  readonly panelId: string;
  readonly panelName: string;
  readonly topic: string;            // "" when null
  readonly debateCount: number;
  readonly turnCount: number;
  readonly latestStatus: DebateStatus | "none";   // "none" → panel created, never debated
  readonly updatedAt: string;
}
export interface SessionsRepos {
  readonly panels: { findAll(): Promise<readonly { readonly id: string; readonly name: string; readonly topic: string | null; readonly updatedAt: string }[]> };
  readonly debates: { findByPanelId(panelId: string): Promise<readonly { readonly id: string; readonly status: DebateStatus; readonly startedAt: string }[]> };
  readonly turns: { countByDebateId(debateId: string): Promise<number> };
}
export interface SessionsDataSource {
  readonly loadList: () => Promise<readonly SessionListItem[]>;
  // loadTranscript added in Task 13
}
export function createSessionsDataSource(repos: SessionsRepos): SessionsDataSource;
```

`loadList`: `panels.findAll()` → for each panel: `debates.findByPanelId(id)`; `debateCount = debates.length`; `turnCount = Σ countByDebateId`; `latestStatus` = status of the most-recent debate by `startedAt` (or `"none"` if no debates). Sort panels by `updatedAt` desc. **No "concluded" — honest `debate.status`.**

- [ ] Test-first: two panels — one with two debates (sum turns; latest status by startedAt), one with no debates (`debateCount:0`, `turnCount:0`, `latestStatus:"none"`). Assert sort order. Implement. `test(tui):` then `feat(tui):`.

---

## Task 12: `SessionsScreen` (list)

**Files:** Create `SessionsScreen.tsx`; modify `AppRouter` (swap placeholder); Test `sessions-screen.test.tsx`.
Rows: `"<status-symbol> <panelName>  <debateCount> debates · <turnCount> turns  <topic>"`. Status symbol from a small map (`completed → ✓`, `running → …`, `interrupted/aborted/failed → ⚠`, `none → ·`) via `getSymbols()`/theme; all text sanitized. Empty CTA "No sessions yet — convene a panel with `c`". `onActivate` → `navigate(/sessions/<panelId>)`.
- [ ] Test-first (loaded with the status symbol bound to its row; empty; error), then implement. (Bind the symbol to the item per #1584's lesson.)

---

## Task 13: `sessions-data.loadTranscript`

**Files:** Modify `sessions-data.ts`; extend `sessions-data.test.ts`.

**Interfaces — Produces:**

```ts
export interface TranscriptLine {
  readonly speaker: string;          // expert displayName/slug or speakerKind
  readonly round: number;
  readonly content: string;          // raw; screen sanitizes with stripControlChars
  readonly kind: "user" | "expert" | "moderator" | "system" | "human";
}
export interface SessionTranscriptView {
  readonly panelName: string;
  readonly topic: string;
  readonly prompt: string;
  readonly status: string;
  readonly lines: readonly TranscriptLine[];
}
// on SessionsDataSource:
readonly loadTranscript: (panelName: string) => Promise<SessionTranscriptView | undefined>;
```

Inject `loadTranscript`-equivalent as a dep so the adapter stays unit-testable WITHOUT a DB:

```ts
export interface SessionsTranscriptDeps {
  readonly loadTranscript: (panelName: string) => Promise<{
    readonly panel: { readonly name: string; readonly topic: string | null };
    readonly experts: readonly { readonly id: string; readonly slug?: string; readonly displayName?: string }[];
    readonly latestDebate: { readonly prompt: string; readonly status: string };
    readonly turns: readonly { readonly expertId: string | null; readonly round: number; readonly content: string; readonly speakerKind: TranscriptLine["kind"] }[];
  } | undefined>;
}
```

Map each turn: `speaker` = matching expert's `displayName ?? slug` by `expertId`, else the `speakerKind`. Resolve panel-not-found (`loadTranscript` returns `undefined`) → `undefined`.

- [ ] Test-first with a fake `loadTranscript` returning a 2-expert, 3-turn doc; assert `lines` speakers/rounds/kinds; assert undefined passthrough. Implement. `test(tui):` then `feat(tui):`.
- [ ] In `index.tsx` glue, build the real dep: `loadTranscript: (name) => loadTranscript(db, name)` from `src/memory/transcript.js`.

---

## Task 14: `SessionDetailScreen` (transcript)

**Files:** Create `SessionDetailScreen.tsx`; modify `AppRouter` (add `ROUTES.sessionDetail`, note param is the **panelId** but `loadTranscript` needs **panelName** — pass the name via router state from `SessionsScreen.onActivate`, OR resolve id→name through the sessions list; carry `panelName` in navigation state to avoid an extra lookup); Test `session-detail-screen.test.tsx`.

**Behavior:** read panel name (from route state or a `:id`→name resolution); `useData().sessions.loadTranscript(name)`; header shows panel/topic/prompt/status; body renders the transcript lines in a `ScrollView` (`"[r{round}] {speaker}: {content}"`, content via `stripControlChars` — multi-line allowed). `Esc` → back. Loading/empty(no turns)/not-found/error states.

- [ ] Test-first (renders lines; not-found; Esc back, real-timer wait), then implement.

---

## Task 15: `palette-commands` builder

**Files:** Create `packages/cli/src/tui/adapters/palette-commands.ts`; Test `palette-commands.test.ts`.

**Interfaces — Produces:**

```ts
export interface PaletteAction { readonly id: string; readonly label: string; readonly route?: string; readonly kind: "navigate" | "help" | "quit"; }
export interface PaletteContext { readonly navId: string; }
export function buildPaletteCommands(ctx: PaletteContext): readonly PaletteAction[];
```

Always includes: Go to Home/Panels/Experts/Sessions/Settings (`kind:"navigate"`, `route`), Help (`kind:"help"`), Quit (`kind:"quit"`). Context-first ordering: the current section's siblings ranked first (e.g., on `panels`, "Go to Panels" deprioritized/last; others first) — keep it simple: stable global list, with the current `navId`'s own entry filtered out (you're already there).

- [ ] Test-first: on `navId:"home"`, returns all nav targets except Home + Help + Quit; on `navId:"panels"`, excludes the Panels entry. Implement. `test(tui):` then `feat(tui):`.

---

## Task 16: Wire `CommandPalette` to `Ctrl-K` + navigation

**Files:** Modify `AppRouter.tsx` (add `palette` to the focus mode; `Ctrl-K` opens it; render `CommandPalette` above the routes when active; `onSelect` dispatches the `PaletteAction` — navigate/help/quit; `Esc` closes); Test: extend `app-router.test.tsx` (or a new `command-palette-wiring.test.tsx`).

**Behavior:**
- Extend `FocusMode` to `"nav" | "help" | "palette"`.
- In `useInput`: `if (key.ctrl && input === "k") { setMode("palette"); return; }`. While `mode==="palette"`, the nav list + screen lists are `isActive={false}` (palette steals focus).
- `commands = buildPaletteCommands({ navId })`; render `<CommandPalette commands={commands.map(c => ({id:c.id,label:c.label}))} onSelect={onPaletteSelect} onClose={() => setMode("nav")} isActive={mode==="palette"} />`.
- `onPaletteSelect(id)`: find the action; `navigate` → `setMode("nav")` + `navigate(route)`; `help` → `setMode("help")`; `quit` → `app.exit()`.
- Footer hint updates to include `^K Palette`.

- [ ] **Test-first:** render `CouncilTUI`; send `Ctrl-K` (`"\u000b"` is Ctrl-K; in ink-testing assert via `key.ctrl && input==="k"` — send `"\u000b"`), flush, assert the palette renders (`> ` prompt). Type a query to filter to a target, press `\r`, assert the route changed (breadcrumb/screen). Add an `Esc`-closes test (real-timer wait) and a Quit-action test (spy `useApp().exit` via rendering and asserting unmount, or assert the quit action id is dispatched). Then implement.

> **Ctrl-K keycode:** ink delivers Ctrl-K as `input === "k"` with `key.ctrl === true` (the raw byte is `\u000b`). Test by `stdin.write("\u000b")` and gate on `key.ctrl && input === "k"`. Verify in the RED run; if ink surfaces it differently under v7, adjust the guard and the test together (do not weaken the test).

---

## Self-Review (run before finalizing)

1. **Spec coverage (design §5 user stories for M2 / 9.3):** Panels browse/inspect (E) → Tasks 3–7; Experts browse/inspect (C) → Tasks 8–10; Sessions browse + transcript + convened/concluded status (I, G) → Tasks 11–14 (status = honest `debate.status`); `Ctrl-K` palette (A) → Tasks 15–16; left-nav reachability + nav highlight (I) → Task 2. Built-in templates browse (E) → Tasks 3/6 (`source:"template"`).
2. **Placeholder scan:** none — every task has real adapter code/tests and concrete screen behavior. Screen JSX skeletons name exact props, states, and sanitizers.
3. **Type consistency:** `PanelListItem`/`PanelDetailView`/`PanelMemberView`, `ExpertListItem`/`ExpertDetailView`, `SessionListItem`/`TranscriptLine`/`SessionTranscriptView`, `PaletteAction` are defined once and consumed by name. `TuiDataSources` grows `experts?`/`sessions?` as their PRs land (optional until then; `useData().experts!`-style access guarded by the screen only rendering on its own route after its PR).

## Risks & Mitigations
| Risk | Mitigation |
|------|-----------|
| Async `useEffect` data loading is flaky to test | Centralize in tested `useAsyncResource` (Task 5); screens flush with `setImmediate` loop; adapters tested separately at 100%. |
| `loadTranscript` needs a real DB | Adapter takes an injected `loadTranscript` dep (Task 13) — unit-tested with a fake; `index.tsx` supplies the real one. |
| Detail routes need `source`/`name` not in the URL param | Carry `source`/`panelName` via react-router navigation **state**; tests pass it through `MemoryRouter initialEntries={[{ pathname, state }]}`. |
| `Ctrl-K` keycode differs under Ink 7 | Verify in the RED run; adjust guard + test together; never weaken the test. |
| `index.tsx` accumulating wiring logic | Extract `buildDataSources(db, dataHome)` into a tested `.ts` if construction is non-trivial — keep `index.tsx` glue (M1 PR #1585 rule). |
| Screen renders unsanitized DB/model strings | Every `<Text>` sink uses `toSingleLineDisplay` (single-line) / `stripControlChars` (transcript); audit each screen's every field. |

## Execution Handoff
Plan saved to `docs/superpowers/plans/2026-06-23-tui-m2-library-browse-plan.md`. Execute via **subagent-driven-development**: one delegated implementer per PR (PR-A first; PR-B after; PR-C/PR-D/PR-E may parallelize after PR-B; PR-F after PR-E; PR-G last), each stops at "PR opened"; the parent invokes Sentinel per PR and merges on APPROVED/CONDITIONAL.
