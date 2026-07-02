# Interactive TUI — Design & Architecture (Council Console)

> **Status:** Approved design for [ROADMAP.md](../../ROADMAP.md) **Phase 9: Interactive TUI**.
> Implementation is sequenced in [IMPLEMENTATION-PLAN.md](../../IMPLEMENTATION-PLAN.md) §9 (9.1–9.10).
> This document is the authoritative design; per-increment detail lives in the implementation plan.

Council is feature-complete via its CLI (`convene`, `chat`, `ask`, `conclude`, `expert`/`panel`
CRUD, `expert train`, `memory`, `sessions`, `config`, …). The CLI is ideal for agents and power
users, but a regular user wants one discoverable surface. **Phase 9 adds a full-screen interactive
terminal UI**: running bare `council` on a TTY drops the user into a navigable console where they can
do everything Council offers — change settings, create/select panels, browse what a panel has
convened or concluded, chat 1:1 with an expert or with a panel, author and train persona experts,
and convene a live deliberation — without memorizing subcommands.

## 1. North Star

Running `council` transports the user into a **deliberation chamber that lives in the terminal**: a
clean full-screen canvas with the active panel/session context always in the header and available
actions always hinted in the footer. Navigation is as effortless as scrolling `lazygit` — `j/k` to
move, `Enter` to go deeper, `Esc` to surface. A live convene feels like a text roundtable: each
expert distinctly colored, animated "thinking" pills showing whose turn it is, the input box waiting
at the bottom. Canceling is harmless (partial output preserved); quitting is safe (confirmation
required); every operation that costs premium requests shows its cost before committing. It degrades
gracefully: no color → readable plain text; narrow terminal → compact mode; pipe/CI → the existing
CLI subcommands, no TUI at all.

This builds directly on the existing vision in [`docs/UX_DESIGN.md`](../UX_DESIGN.md) (the "Round
Table" metaphor, color system, layered disclosure, and interruption model).

## 2. Goals & Non-Goals

**Goals**
- A single discoverable surface where a non-power user can use all of Council without subcommands.
- Reuse ~100% of existing business logic (engine, repositories, debate orchestrator, chat sessions,
  config). The TUI is a presentation/orchestration layer, not a rewrite.
- Preserve the full CLI for agents, scripts, and CI — zero regressions to existing commands.
- Accessibility and robustness (NO_COLOR, screen readers, resize, non-TTY) as first-class from the
  first shipped milestone.

**Non-Goals (YAGNI for v1)**
- No mouse-first design (keyboard-first; mouse optional later).
- No multi-pane "IDE" layout (Miller columns / split editors). Max 3 navigation levels.
- No theming engine / multiple color themes (one semantic palette + NO_COLOR/ASCII fallback).
- No background document daemon (Roadmap §6.5 stays deferred).
- No new provider adapters (tracked separately under Phase 8 / 1.0 Readiness).
- No `$EDITOR` spawning — the TUI provides native multi-line editing.

## 3. Entry & Launch Behavior

| Condition | Behavior |
|-----------|----------|
| `council` (no args), `process.stdout.isTTY && !isInCI()` | Launch the TUI in the alternate screen |
| `council` (no args), non-TTY / piped / redirected / CI | Print today's grouped help (unchanged) |
| `council <subcommand> …` | Always run the existing command; never launch the TUI |
| `council ui` | Explicit, discoverable command that launches the TUI (alias of bare `council`) |
| `council --help` / `-h` / `--version` | Existing behavior (no TUI) |
| Escape hatches | `--no-tui` and `COUNCIL_NO_TUI=1` force the help path even on a TTY |
| Rollout | TUI is opt-in behind `COUNCIL_TUI=1` during 9.2–9.9; 9.10 flips bare-`council`-on-TTY to default |

Startup guard: `const interactive = process.stdout.isTTY && !isInCi();` — when false, route to the
CLI program and print: *"Running non-interactively — use `council convene \"topic\"` for one-shot
mode."* Explicit subcommands bypass the TUI entirely, so agents/scripts/CI are unaffected.

## 4. UX & Interaction Design

### 4.1 App shell — 3-zone alternate-screen layout
- **Header (2 rows):** wordmark + breadcrumb (`Council ▸ <panel> ▸ <topic>`) + active model + live
  token/cost meter. Compact < 100 cols; minimal < 80.
- **Main (flex):** the current screen / chat stream. Only this zone scrolls.
- **Footer/status (1–2 rows):** contextual key hints (left) + transient status messages with TTL
  (right) + the current mode indicator (`NAV` / `TYPE` / `STREAM`).
- **Collapsible left nav** column (see §4.2) is drawn between the left edge and Main.
- Rendered with Ink 7 `render(<CouncilTUI/>, { alternateScreen: true, incrementalRendering: true })`;
  resize handled via `useWindowSize()`.

### 4.2 Navigation — hybrid + collapsible left nav, max 3 levels
- **Home dashboard** is the landing view: recent sessions (dominant scrollable list), quick-action
  CTAs (Convene, New expert, New panel, Settings), and counts (N sessions / N experts / N panels).
- **Home launchpad keyboard navigation**: the quick actions and recent sessions form a single
  navigable list (quick actions first, then recent sessions) with one `›` cursor. `j/k`/`↑/↓` move
  the cursor and `Enter` activates the highlighted row — a quick action navigates to its route, a
  recent session opens `/sessions/:id`. The direct letter shortcuts (`c`/`e`/`p`/`,`) always fire
  regardless of cursor position. This list has its own focus, independent of the left nav's `j/k`
  cursor (see §4.3 dual focus model); both are inert while the other pane is focused.
- **Collapsible left nav** (Home / Panels / Experts / Debates / Conversations / Settings) — combines the
  hybrid model with an optional fixed sidebar. Three states: **expanded** (labels) / **icon rail**
  (~3 cols, orientation kept) / **hidden** (max reading width). Adaptive default by width
  (expanded ≥120 · rail 80–119 · hidden <80) plus a manual toggle on a dedicated configurable key —
  default `\`, chosen to avoid `Ctrl-B` (tmux prefix).
- Drill-down: Home → List → Detail; **never deeper than 3**. Expert detail within a session is a
  sidebar/overlay, not a 4th level.
- `Enter` drills in, `Esc` backs out (Home `Esc` → confirm-quit). Breadcrumb embedded in the header.
- Tabs are used **within** a detail view (e.g. Session Detail → Chat / Experts / Summary), never
  between top-level areas.
- Routing: `react-router` `MemoryRouter` as the screen stack; overlays (palette, dialogs) are
  parallel state drawn above the route.

#### Mockup — Home (collapsible nav expanded)
```
┌────────────┬───────────────────────────────────────────────────────────────────────┐
│ 🏛 Council  │ Home                                       claude-sonnet-4.5   ◷ 0 req  │
│            ├───────────────────────────────────────────────────────────────────────┤
│ ▸ Home     │  Recent sessions                                Quick actions          │
│   Panels   │  ┌───────────────────────────────────────────┐  ┌──────────────────┐   │
│   Experts  │  │ ●  Microservices migration  2d  5 experts │  │ c  Convene       │   │
│   Debates  │  │ ○  Q1 roadmap planning      1w  4 experts │  │ e  New expert    │   │
│   Convs.   │  │ ○  Security audit review    2w  concluded✓│  │ p  New panel     │   │
│   Settings │  └───────────────────────────────────────────┘  │ ,  Settings      │   │
│            │                                                  └──────────────────┘   │
│ 9 experts  │  12 sessions · 9 experts · 5 panels                                     │
│ 5 panels   │                                                                         │
├────────────┴───────────────────────────────────────────────────────────────────────┤
│ \ collapse nav   j/k move   ↵ open   c convene   ^K commands   ? help          NAV   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

#### Mockup — Live convene (nav collapsed to icon rail)
```
┌───┬───────────────────────────────────────────────────────────────────────────────┐
│🏛 │ architecture-review ▸ "Build vs buy analytics?"        sonnet-4.5    ◷ 6 req    │
│   ├───────────────────────────────────────────────────────────────────────────────┤
│ ⌂ │  [CTO ✓]   [CFO ●]   [VP Product ○]            ← expert pills (● thinking, ✓ done)│
│ ▥ │                                                                                 │
│ ◆ │  CTO · Priya Mehta                                                              │
│ ≡▸│    Building in-house gives full pipeline control, but be honest about cost: 3    │
│ ✦ │    engineers for 6+ months, plus ongoing maintenance…                           │
│ ⚙ │                                                                                 │
│   │  CFO · James Whitfield  ▌ thinking…                                             │
│   │  ─────────────────────────────────────────────────────────────────  round 1 ── │
│   │  ›  interject, or @CTO…                                          ▁▁▁▁▁           │
├───┴───────────────────────────────────────────────────────────────────────────────┤
│ \ nav   Esc cancel (keeps partial)   ^K commands   ↑ scroll   tab type      STREAM  │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Dual focus model — the #1 correctness rule
Two explicit modes, shown in the footer:
- **Navigation mode:** `j/k`+`↑/↓` scroll, `Enter` open, `Esc` back, `/` filter, `?` help, `Tab`
  switch focus, `g/G` top/bottom, PgUp/PgDn.
- **Typing mode** (input focused): all keys type; `Enter` submits; `Shift+Enter`/`Ctrl+J` newline;
  `Esc` returns to navigation. **`j`/`k`/`/`/`?` must NOT fire while typing.**
- Implemented with a `mode` state gating each `useInput({ isActive })` (Ink 7 `useFocusManager`).

### 4.4 Command palette (`Ctrl-K`)
Centered modal, fuzzy **subsequence** match (`nse` → "New Session"), character-level highlights,
shortcut shown next to each command, scored by match + recency. Contextual first, then global:
chat → *Send to all, Cancel, Conclude, Export, Switch model*; dashboard → *New session, Resume,
Create expert/panel*; always → *Settings, Help, Quit*. Opens from any mode (suspends, doesn't block);
`Esc` dismisses with no side effects. Slash commands (`/help`, `/conclude`, `/model`, …) remain as a
secondary expert path.

### 4.5 Keyboard & discoverability
Dual-bind vim + arrows everywhere. `?` opens a full keybinding overlay; the footer shows the 5–6 most
relevant keys and updates with context/mode. `Ctrl+C`: first press cancels in-progress generation;
second press (or at idle) → confirm-quit.

### 4.6 Chat-stream view (1:1 and panel)
Lazy/virtualized message list with **per-item render caching** for streaming performance.
**Follow mode** auto-scrolls during streaming; manual `↑/k/PgUp` breaks follow; `G` jumps to bottom;
`↓ N new` affordance when scrolled up. Per-expert fixed colors (name prefix only), `@mention`
highlighting, animated "thinking" pill, multi-line growing input (1→~5 rows) with char/token count.
Input border: accent when focused, dim when not.

### 4.7 Convene (live debate) view
Topic input → **cost-confirmation modal** (estimated premium requests / $) → stream. A row of
**expert pills** near the top (`●` pulsing while thinking, `✓` done), per-expert colors, round/phase
separators (structured mode), live cost meter in the footer. `Esc` cancels via `AbortSignal`; partial
output is preserved with a dimmed `[cancelled]` tag. Consumes
`Debate.run(prompt, { signal })` → `DebateEvent` stream directly (§6.2).

**Review mode (transcript key contract).** The transcript viewport auto-follows new turns
(live-follow) until the user scrolls it manually — implemented as a pure `followLive`/`cursor` state
machine (`src/tui/lib/review-scroll.ts`) driving `ScrollView`'s `cursor`/`follow` props:
- `↑` / `k` / `PgUp` — pause auto-follow and enter **Review mode**, moving the cursor up one line
  (from live-follow, the cursor starts at the last line and steps up from there).
- `↓` / `j` / `PgDn` — move the cursor down one line; reaching the last line resumes live-follow
  automatically (equivalent to pressing `End`/`G`).
- `End` / `G` — unconditionally resume live-follow; cursor jumps to the last line.
- While paused, the footer shows `⏸ Review — ↓/End to resume live`; new streamed turns keep
  appending to the transcript underneath but do **not** pull the viewport back to the bottom until
  live-follow resumes.
- `Esc` still cancels the run (while streaming) or backs out (once done) regardless of review state.

### 4.8 Sessions — list & session detail
The **Debates** nav entry (`/sessions`; the command palette labels the same destination "Go to
Sessions") lists **every panel in the library**, most-recently-updated first — including panels that
have never convened a debate:
- Each row reads `<status symbol> <panel name>  <N> debates · <N> turns  <topic>`, e.g. `✓ Finance
  Council  1 debates · 4 turns  Q3 budget` (the count copy is not pluralized — `1 debates` is
  expected, not a typo). A never-convened panel still gets a row, e.g. `· Growth Council  0 debates
  · 0 turns`.
- Status symbol reflects that panel's most recent debate: `✓` completed · `…` running · `·` no
  debates yet · `⚠` interrupted/aborted/failed.
- Standard list keys apply (§4.3): `j/k`/arrows move, `g`/`G` jump top/bottom, `PgUp`/`PgDn` page,
  `/` filters, `Enter` opens the highlighted row.
- Empty state — zero **panels** in the library, not merely zero debates — shows the guidance text
  *"No debates yet — convene a panel to watch them deliberate"*. This is inline copy, not a bound
  key — start a debate from Home (`c`) or the command palette instead.

Opening a row navigates to the **session detail** screen (`/sessions/:id`), which renders that
panel's most recent debate in full: panel name, topic, prompt, status, and every turn as `[r<round>]
<speaker>: <content>`. Two actions are available, footer-hinted as `c conclude · x export` and also
reachable through an `a` action-menu overlay (`Esc` closes it without acting):
- `c` — open the conclusion flow (`/sessions/:id/conclude`).
- `x` — open the export overlay (`/sessions/:id/export`).

This is the full transcript implementation, not a placeholder: an earlier increment shipped a
temporary `PlaceholderScreen` at this route pending the real view; `SessionDetailScreen`
(`src/tui/screens/SessionDetailScreen.tsx`) has since replaced it.

### 4.9 Expert detail — persona documents (`o`)
The expert detail screen (`/experts/:slug`) footer-hints `c chat · e edit · d delete` for every
expert, surfaced in the `a` action-menu overlay too. **Persona-kind experts only** get two further
actions, on their own footer line (`o documents · t train`) and appended to that same menu:
- `o` — open the **expert documents** screen (`/experts/:slug/docs`; breadcrumb `Experts › <slug> ›
  Documents`).
- `t` — open the training flow (`/experts/:slug/train`).

Both keys are no-ops for **generic** experts — a generic expert has no docs folder to manage, so the
screen does not wire `o`/`t` to anything when the loaded expert's `kind !== "persona"`.

The expert documents screen lists that persona's indexed source documents, one row per document as
`<filename>  <size>B  [<status>]`, navigable with the same `j/k`/arrows/`g`/`G` keys. Pressing
`Enter` on a row asks `Remove "<filename>"? [y/n]` inline; `y` marks it removed and drops it from the
search index (a warning banner appears if index cleanup fails, suggesting a re-train to repair it),
`n` cancels. Empty state: *"No indexed documents for this persona."*

### 4.10 Settings (overlay, not a screen)
60–70% × 80% overlay over the current view; collapsible sections mirroring `ConfigSchema`:
*Defaults, Expert, Documents, Chat, Conclude, Telemetry, Providers (env-var names only), Paths*.
`Tab`/`Shift+Tab` between fields; **inline Zod validation** below each field; `[Save]`(`Ctrl+S`)
`[Cancel]`(`Esc`). Native textarea for multi-line — never spawn `$EDITOR`.

### 4.11 First-run, empty states, errors
First-run: ≤ 2 onboarding screens (welcome/value + model/auth check, reusing
`loadConfigWithMeta().isFirstRun` + `selectModelInteractively`), then Home. Empty states: large,
specific CTAs with the action key (`⊕ Start your first Council session [c]`). Tiered errors:
transient → status bar (5s TTL); persistent → inline item with `⚠`; blocking → modal. Never render
raw stack traces; map via `formatEngineError`.

### 4.12 Accessibility & responsiveness (from the first milestone)
`NO_COLOR` / `TERM=dumb` / `COUNCIL_ASCII` honored (reuse `getSymbols()`, chalk auto-detect). Ink 7
screen-reader mode (`INK_SCREEN_READER`) → linear frames, no cursor tricks; spinner is a braille
sequence ≤10fps, static `[...]` under NO_COLOR. Breakpoints: ≥120 full (nav expanded) · 80–119
nav→rail + compact header · 60–79 nav hidden + icon-only footer · <60 "terminal too narrow" minimal
mode. Reflow (not truncate) on resize. Semantic color tokens (accent/error/warn/muted/success/
per-expert) resolved at runtime — no hardcoded hex — building on `docs/UX_DESIGN.md` and the existing
8-color palette in `packages/cli/src/cli/renderers/ink/colors.ts`.

## 5. User Stories

Grouped by epic; each maps to a screen and the existing core seam it drives. The 9.x reference is the
implementation milestone (see [IMPLEMENTATION-PLAN.md](../../IMPLEMENTATION-PLAN.md) §9).

**Onboarding & navigation** — land in the TUI from bare `council` (9.2); guided ≤2-step first run
(9.9); recent sessions + quick actions on Home (9.2/9.3); `j/k`/`Enter`/`Esc` nav with footer + `?`
discoverability (9.2); `Ctrl-K` fuzzy palette (9.3); reach any section from the collapsible left nav
(9.2); non-TTY prints help (9.2).

**Settings** — change default model/engine/max rounds/experts/words; toggle telemetry; tune chat,
conclude, and document settings; set a provider's API-key **env-var name** (never the secret); inline
validation before save (9.4).

**Experts** — create a **generic** expert via a guided form (slug, display name, role, expertise,
epistemic stance, optional personality/model); create a **persona** expert (kind=persona, persona
description, docs folder); browse/inspect; edit/delete with affected-panel warnings (9.5; browse 9.3).

**Expert training** — add documents to a persona by path or URL (native description textarea); watch
multi-step indexing progress (extract → chunk → index → profile); list/remove indexed docs; retrain
refreshes the synthesized profile (9.5).

**Panels** — create a panel by multi-selecting from available experts; auto-compose from a topic with
confirmation; browse/inspect/edit/delete panels and members; start from one of the 17 built-in
templates (9.6; browse 9.3).

**Convene** — select a panel, enter a topic, see estimated cost, and confirm before spending; watch
the debate stream live (pills, colors, round/phase markers); `Esc` to cancel keeping the partial
transcript; live token/cost in the footer (9.8).

**Conclude** — generate a structured conclusion (decision matrix, tensions, recommendation); a
session detail shows whether it was convened and/or concluded (9.8; status 9.3).

**Chat** — open a 1:1 chat with an expert (streaming); open a panel chat with `@mention`; trigger an
inline `@convene <topic>` and return to chat; chats persist and resume (9.7).

**Sessions & history** — browse all past debates and chat sessions with status/recency; open a
session to read its transcript (9.3).

**Memory** — view an expert's accumulated memory and provenance in the expert detail; reset an
expert's/panel's debate memory while keeping persona profiles (9.9).

**Export & share** — export a session to markdown / JSON / ADR / share from an overlay (9.9).

**Robustness** — readable under NO_COLOR/screen-reader; reflow without corruption on resize; tiered
error display (9.2/9.9).

## 6. Technical Architecture

### 6.1 Module layout (new — `packages/cli/src/tui/`)
```
src/tui/
  index.tsx                 entry: interactive guard + render(<CouncilTUI/>, {alternateScreen,…})
  CouncilTUI.tsx            root: MemoryRouter + global overlays (palette, dialogs, help) + providers
  router/routes.ts          route constants ('/', '/panels/:name', '/experts/:slug', '/sessions/:id')
  screens/                  Home, Panels, PanelDetail, Experts, ExpertDetail, Sessions,
                            SessionDetail, Chat, PanelChat, Convene, Conclude
  components/
    layout/                 AppShell, Header, Footer, StatusBar
    navigation/             LeftNav (collapsible), Breadcrumb
    overlays/               CommandPalette, ConfirmDialog, HelpModal, SettingsDialog, CostDialog
    inputs/                 TextInput(re-export), MultilineInput(custom), SelectInput(re-export),
                            MultiSelect
    lists/                  ScrollView (windowed), ItemList (generic selectable)
    streaming/              TokenStream (AbortController), DebateStreamView, ExpertPills
    feedback/               Spinner (wrap), ProgressBar, StepList
  hooks/                    useMode, useScrollView, useCommandPalette, useNavigation,
                            useInteractiveGuard
  state/                    React Context + useReducer stores (app/session/streaming)
  theme/                    semantic color tokens + NO_COLOR/ASCII resolution
  adapters/                 thin async wrappers over core seams (return view-models + streams)
```
- **State:** React Context + `useReducer` (not Zustand) — clear parent/child ownership, easy to reset
  per test. One small streaming context is shared between Convene/Chat and the header/footer meters.
- **Reuse over rebuild:** the TUI imports `core/`, `memory/repositories/`, `config/`, `engine/`
  directly. The package's `src/index.ts` stays a `buildProgram`-only public surface.

### 6.2 Reusable seams (verified, file-level)
| Capability | Seam | Reuse |
|-----------|------|-------|
| Config | `loadConfigWithMeta`, `updateConfigField(s)`, `getCouncilDataHome` (`src/config/loader.ts`) | as-is |
| Engine lifecycle | `runWithEngine`, `makeEngineFromKind`/`createEngine` (`src/cli/run-with-engine.ts`, `src/engine/providers.ts`) | as-is |
| Debate | `new Debate(...).run(prompt,{signal})` → `DebateEvent`; `DebatePersister.persist` (`src/core/debate.ts`, `src/memory/persister.ts`) | as-is |
| Conclude | `buildSynthesisPrompt` + `synthesizeConclusion` (`src/cli/conclusion-synthesis.ts`) | as-is |
| Panels | `template-loader` (`loadPanel`/`resolveExperts`/`listTemplates`), `autoComposePanel`, `PanelLibraryRepository`, `PanelRepository` | as-is |
| Experts | `FileExpertLibrary` CRUD, `ExpertDefinitionSchema`, `allowlistExpertDefinition` (`src/core/expert.ts`, `src/core/expert-library.ts`) | as-is |
| Training | `createDocumentProcessor().process/needsProcessing`, `createDocumentIndexer`, `analyzeDocuments`, `ProfileRepository`, `DocumentRepository` (`src/core/documents/*`) | as-is |
| Chat | `parseUserInput`, `createContextManager`, `ChatRepository`, `build{Chat,Panel}TurnPrompt` (`src/core/chat/*`, `src/cli/commands/chat/shared.ts`) | as-is |
| Sessions/history | `loadTranscript`, `synthesizeEvents` (`src/memory/transcript.ts`), repositories | as-is |
| Memory | `recallMemoryWithProvenance` (`src/memory/expert-memory.ts`), memory repositories | as-is |
| Export | `loadTranscript` + format renderers (`src/cli/commands/export*.ts`) | mostly as-is |
| DB | `createDatabase`, repository constructors (`src/memory/db.ts`) | as-is (one TUI-owned handle) |
| Cross-cutting | `stripControlChars`/`toSingleLineDisplay`, `formatEngineError`, `getSymbols` | must respect |

### 6.3 Required refactors (extract reusable cores from CLI glue), ranked
1. **Split "produce/stream a turn" from "write to stdout"** in `runExpertChat`/`runPanelChat` and the
   convene render path → a reusable turn-producer + event stream the TUI renders in Ink.
2. **Extract panel & expert CRUD services** from `commands/panel.ts` / `commands/expert.ts`
   (validation + fs + DB + atomicity) into pure service modules used by both CLI and TUI.
3. **Extract export format renderers** into a shared pure module.
4. **UI-neutral view-model layer** for sessions/memory/history (`tui/adapters/`).
5. **DB lifecycle:** one TUI-owned `CouncilDatabase` handle passed via context (not per-command).

Each refactor is behavior-preserving and guarded by the existing CLI tests, so the CLI cannot regress.

### 6.4 Dependencies (approved)
`react-router` (`MemoryRouter` screen stack — Ink-team supported), `ink-text-input` (single-line
fields), `ink-select-input` (list selection), `ink-testing-library` (dev — TDD for Ink components).
Already present: `ink ^7.1`, `ink-spinner ^5`, `react ^19.2`, `chalk ^5`. **Not** added:
`ink-use-stdout-dimensions`, `ink-progress-bar`, `fullscreen-ink`, `blessed` (obsolete/incompatible).
Built in-house (no package): `MultilineInput`, `ScrollView` (windowing), `CommandPalette`,
`ExpertPills`, `LeftNav`. State stays on React Context (Zustand not adopted).

### 6.5 Custom primitives to de-risk first (9.1)
Multi-line input · windowed `ScrollView` (pure scroll math) · command-palette focus-stealing
(`useFocusManager` disable/enable) · alt-screen enter/exit + top-level `ErrorBoundary` that restores
the terminal on crash · `useMode` nav/typing gate · non-TTY interactive guard. Also validate
`ink-text-input`/`ink-select-input` under Ink 7 / React 19 (peer ranges declare `>=5`/`>=18`; verify
via stdin tests).

## 7. Testing Strategy (strict TDD — Sentinel-gated)
- **Harness:** `ink-testing-library` `render()` + `stdin.write()` + `lastFrame()`/`frames`; a
  `flush(n)` `setImmediate` helper (matches existing `tests/unit/cli/renderers/ink/*.test.tsx`).
- **Per primitive/screen:** RED test first (keyboard sequences via escape codes: `\x1b[A`, `\t`,
  `\x1b`, `\r`, `\x03`), then minimal impl. Always give components explicit `useFocus` `id`s.
- **Hard-to-test areas + mitigations:** streaming (hold a Promise open; bump flush N / fake timers);
  resize (`mockStdout.emit('resize')`); navigation (`MemoryRouter initialEntries`); cancel
  (`AbortController` hold-open, the existing `ink-ux.test.tsx` pattern); store leakage (fresh context
  per test, no module singletons). Pure logic (scroll math, fuzzy match, mode reducer, cost estimate)
  unit-tested separately from rendering.
- **Refactor safety:** §6.3 extractions are covered by existing CLI tests staying green.
- CI: 4 unit shards + e2e/integration/security behind the `ci-pass` gate; do not enforce coverage
  per-shard.

## 8. Security & Invariants ([AGENTS.md](../../AGENTS.md) / [docs/SENTINEL.md](../SENTINEL.md))
- All model/file/external strings → `stripControlChars`/`toSingleLineDisplay` before render
  (terminal-injection class; audit every sink, not one).
- No secrets in SQLite/config (only provider env-var **names**). `@github/copilot-sdk` stays imported
  only in `engine/copilot/adapter.ts` (ESLint `no-restricted-imports`) — the TUI imports the engine
  abstraction, never the SDK.
- TDD ordering enforced (`test(scope)` before `feat|fix(scope)`); every PR Sentinel-reviewed by a
  non-author; worktree-per-task; never commit on `main`.
- Style: named exports only, explicit return types on public fns, `interface` for object shapes,
  no `any` (use `unknown` + guards), `readonly` by default, Prettier + ESLint strict clean.

## 9. Milestones

Built milestone-by-milestone (each = several TDD PRs) and released together at 9.10
("feature-complete before shipping"). Detailed acceptance criteria are in
[IMPLEMENTATION-PLAN.md](../../IMPLEMENTATION-PLAN.md) §9.

| Impl | Milestone | Delivers |
|------|-----------|----------|
| 9.1 | Spike & de-risk | Add deps; isolated, tested primitives (alt-screen+ErrorBoundary, `useMode`, ScrollView, MultilineInput, CommandPalette focus, non-TTY guard, ink-testing harness) |
| 9.2 | App shell & nav skeleton | 3-zone alt-screen layout, collapsible left nav, MemoryRouter, semantic colors+NO_COLOR, responsive+resize, footer hints, `?` help, Esc/Enter nav, Home. Entry behind `COUNCIL_TUI=1`; non-TTY→help |
| 9.3 | Library browse/detail (read) | Panels/Experts/Sessions list+detail; convened/concluded status; command palette; read-only view-model layer |
| 9.4 | Settings overlay | All config sections, Tab nav, inline Zod validation, Save/Cancel |
| 9.5 | Expert authoring & training | Create generic+persona, edit, delete(+warnings); add docs(path/URL), progress, list/remove, profile refresh; extract expert CRUD service |
| 9.6 | Panel authoring | Create from expert multi-select, edit members, delete; auto-compose+confirm; extract panel CRUD service |
| 9.7 | Chat (1:1 + panel) | Streaming chat, @mentions, follow-scroll, thinking pill, history/resume, @convene; extract produce/stream-turn primitives |
| 9.8 | Convene & conclude | Cost-confirm modal → live DebateEvent stream (pills/colors/phases/cost), Esc cancel; conclude decision-matrix view |
| 9.9 | Inspection/memory/export & a11y polish | Memory in expert detail, export overlay, first-run onboarding, tiered errors, startup warnings, a11y+responsive audit |
| 9.10 | Make default & release | Flip bare `council` on TTY to TUI (`--no-tui`/`COUNCIL_NO_TUI`; non-TTY fallback); add `council ui`; docs; smoke/platform/perf QA; opt-in TUI telemetry |

## 10. Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| Multi-line input / scroll viewport have no off-the-shelf package | Build + exhaustively test in 9.1 before any screen depends on them |
| `j/k` leaking into typing (top TUI bug) | Dual-mode `useMode` gate from 9.2; explicit test |
| Streaming flicker / perf with long debates | `incrementalRendering`, per-item memo cache, windowed list, 30fps throttle |
| Alt-screen not restored on crash | Top-level `ErrorBoundary` → `useApp().exit()`; Ink `signal-exit`; tested |
| `ink-text-input`/`-select-input` peer ranges target Ink 5/React 18 | 9.1 stdin integration tests under Ink 7/React 19; fall back to custom if needed |
| Changing bare `council` breaks agent/CI muscle memory | Non-TTY always falls back to help; explicit subcommands bypass; opt-in flag until 9.10 |
| Scope creep on a large surface | Milestone gating, YAGNI non-goals, 1 PR per increment, Sentinel |

## 11. Definition of Done (v1)
- Every user story in §5 reachable in the TUI; full CLI unchanged and green.
- Bare `council` launches the TUI on a TTY, falls back to help otherwise; `--no-tui`/`COUNCIL_NO_TUI`
  honored; `council ui` works.
- NO_COLOR, screen-reader, resize, and responsive breakpoints verified; no raw stack traces.
- All PRs TDD-ordered and Sentinel APPROVED/CONDITIONAL; lint/typecheck/tests green; coverage ratchet
  not decreased.
- Docs updated (README, `docs/UX_DESIGN.md`, a tutorial, Phase 9 in ROADMAP/IMPLEMENTATION-PLAN);
  smoke + platform-smoke pass.

---

### Appendix — research provenance
- **Reference TUIs:** crush, gemini-cli, lazygit, k9s, gh-dash, atuin, yazi, fzf, Textual, aider,
  Claude Code, codex (navigation, palette, chat-stream, accessibility, anti-pattern synthesis).
- **Ink 7 / React 19:** first-party `alternateScreen`, `incrementalRendering`, `useWindowSize`,
  `useFocus`/`useFocusManager`, `usePaste`, `useAnimation`, `useBoxMetrics`, `useCursor`,
  screen-reader mode, and `react-router` `MemoryRouter`; `ink-testing-library` v4.
- **Codebase seams:** mapped across `config/`, `engine/`, `core/`, `memory/repositories/`, `cli/`
  (§6.2). Existing vision: [`docs/UX_DESIGN.md`](../UX_DESIGN.md).
