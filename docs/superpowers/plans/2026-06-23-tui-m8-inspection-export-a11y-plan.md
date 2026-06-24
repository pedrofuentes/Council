# Council TUI — Milestone 9.9 (M8 Inspection, Memory, Export & A11y Polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Round out the TUI with the read-mostly surfaces that make it a complete app — inspect an expert persona's learned **memory** (communication style, decision patterns, biases, vocabulary, document stats); **export** a session/panel transcript (markdown / json / share) from inside the TUI; a **first-run onboarding** flow; a **tiered error display** + startup warnings; and an **accessibility / responsive / help-discoverability** audit across every screen built in 9.1–9.8. Behind `COUNCIL_TUI=1`; the full CLI (`expert inspect`, `memory inspect`, `export`) stays untouched.

**Architecture:** Each surface is a tested `.ts` adapter (injected repos / loaders, sanitized view-model, 100% branch) wired inline in the coverage-exempt `index.tsx`, plus a thin `.tsx` screen/overlay with behavioral tests. Everything here is **read-only or local-file** — no engine streaming, no live debate — so the milestone is low-risk relative to 9.7/9.8; the discipline is sanitization (all content is model/file/user-derived), gating the one write (export-to-file), and exhaustive responsive/NO_COLOR coverage.

**Tech Stack:** TypeScript ESM, Ink 7, React 19, `react-router`, Vitest + `ink-testing-library`, temp DB (`createDatabase` + `copyTemplateDb`).

## Global Constraints (every task — the M0–M8 learnings)
- Node ≥ 24; ESM; **`.js` import specifiers**; `.tsx` starts with `import React from "react";`. Named exports only; explicit return types; `interface` for object shapes; `readonly` default; no `any` (use `unknown` + guards).
- **TDD (Sentinel-enforced):** `test(scope)` (RED-confirmed) precedes `feat(scope)`. Never combine. The `test → fix` pair is compliant ordering.
- **100% branch coverage on every new `.ts` adapter** (`pnpm exec vitest run <file> --coverage --coverage.include='src/tui/adapters/<file>.ts'` before the feat commit). Tests ASSERT behavior + **bite** (mutation-verify each guard).
- **Wiring inline in `index.tsx`** (coverage-exempt `.tsx`); behavior in the tested `.ts` adapters with injected deps (repos, loaders, fs writer). Offline-testable with temp DBs + fakes.
- **Sanitize every model/file/user string at the `<Text>` sink:** single-line labels (expert name, slug, format name, file path, dimension label) via `toSingleLineDisplay`; **multi-line bodies** (persona prose, transcript export preview, biases/vocabulary lists) via `stripControlChars` (preserves intended newlines, strips ANSI/control). Persona profiles + documents + transcripts are all model/file-derived = untrusted.
- **Gate the one write** (export-to-file): only enabled when loaded + not `inFlight`; mutation-verify the biting test. Read-only surfaces (memory/onboarding/help) need no write gate but must not crash on `null`/empty (no profile, no documents, no transcript).
- **Captured surfaces** (any TextInput/overlay — export filename, onboarding model pick): input-capture context + idle-gated Esc `if (key.escape){ if(!inFlight.current) navigate(-1)/close(); return; }`; test the back branch **with a back-stack route** so the nav test bites.
- **Per increment:** worktree off `main`; `pnpm install --frozen-lockfile`; `pnpm test` + `lint` + `typecheck` before PR; PARENT invokes Sentinel; delegated implementers STOP after opening the PR (report PR URL + HEAD SHA).

## Verified seams (against `main` 2026-06-23 — source of truth)
- **Expert memory / persona**: `ProfileRepository.findBySlug(slug): Promise<PersonaProfile | null>` (`src/memory/repositories/profile-repository.ts:95`). `PersonaProfile` carries `communicationStyle`, `decisionPatterns`, `biases`, `vocabulary`, `epistemicStance`, `documentCount`, `totalWords`, `lastUpdated`. Documents: `DocumentRepository.findByExpert(slug): Promise<readonly ExpertDocument[]>` (`src/memory/repositories/document-repository.ts:103`). CLI parity: `expert inspect` (`src/cli/commands/expert.ts`), `memory inspect <panel> --expert <slug>` (`src/cli/commands/memory.ts`, `recallMemoryWithProvenance`). Read-only — no engine.
- **Export**: `EXPORT_FORMATS = ["markdown","json","adr","share"] as const` + `ExportFormat` (`src/cli/commands/export.ts:55-56`); `loadTranscript(db, panelName, debateId?)` + `synthesizeEvents` (`src/memory/transcript.ts`); `renderMarkdown` / `renderJson` (NDJSON) / `renderAdr` (`export.ts`); `renderShare` (`export-share.ts`); `loadFullPanelTranscript` (`export.ts`). The TUI export adapter maps `(transcript, format) → string` purely (no fs in the adapter core; the screen owns the optional file write so the pure render stays 100%-coverable).
- **Onboarding / first run**: `loadConfigWithMeta(): Promise<ConfigLoadResult>` with `isFirstRun: boolean` (`src/config/loader.ts:165-199`; ENOENT → `writeDefaultConfig`, isFirstRun true). CLI first-run: `runFirstRunSetupOnce` + `selectModelInteractively` (`src/bin/council.ts`, `src/cli/first-run-model-select.ts`). First-run = missing config file.
- **Errors / warnings**: `ErrorBoundary` class component (`src/tui/components/ErrorBoundary.tsx:14`, `ErrorBoundaryProps` at `:4`), already wired in `src/tui/index.tsx`. Startup warnings flow through `loadConfigWithMeta` + `maybeNotifyUpdate` (`src/bin/council.ts`).
- **A11y / responsive**: `SemanticTheme` + `resolveTheme(env)` honoring `NO_COLOR` / `TERM=dumb` (`src/tui/theme/tokens.ts:3-33`); `computeNavState(columns)` breakpoints **≥120 → expanded, ≥80 → rail, <80 → hidden**, `tooNarrow = columns < 60` (`src/tui/lib/breakpoints.ts:20-26`); AppShell renders "Terminal too narrow (min 60 cols)" when `tooNarrow` (`src/tui/components/layout/AppShell.tsx`). Help hints surface via `Footer` (`src/tui/components/layout/Footer.tsx`).
- **TUI today**: persona `ExpertDetailScreen` exists (no Memory section); `SessionDetailScreen` exists (no export action); no onboarding screen; `ErrorBoundary` fallback is minimal; no contextual help/legend overlay. `TuiDataSources` (`src/tui/DataProvider.tsx`) — add `expertMemory?` / `export?` / `onboarding?` sources. Routes in `src/tui/routes.ts` + `src/tui/AppRouter.tsx`.

## PR decomposition

> Adapter-leading PRs (A, B) are independent and can parallelize off `main`. Screen-wiring PRs that touch `index.tsx` / `routes.ts` / `AppRouter.tsx` / `DataProvider.tsx` serialize — rebase each on the prior merge.

### PR-A — Expert memory inspection (adapter + Memory section) — `m8_prs: A`
- [ ] `test(tui)`: `tests/unit/tui/expert-memory.test.ts` — drive `createExpertMemorySource({ profileRepo, documentRepo })` against a temp DB seeded with a profile + documents; assert the sanitized view-model (style/patterns/biases/vocabulary arrays, `documentCount`/`totalWords`/`lastUpdated`), the **null-profile** path (slug with no profile → a defined "no memory yet" view, not a throw), and that every string field is run through the sanitizer (bite: a profile field with an embedded `\u001b[2K` / newline renders single-line/stripped). RED-confirm.
- [ ] `feat(tui)`: `src/tui/adapters/expert-memory.ts` — `createExpertMemorySource(deps)` returning `{ load(slug): Promise<ExpertMemoryView> }`; 100% branch.
- [ ] Surface as a **Memory section** on the persona `ExpertDetailScreen` (or a `/experts/:slug/memory` sub-route) — communication style, decision patterns, biases, vocabulary + document count / total words / last updated. Behavioral `.tsx` test (renders seeded view; renders the empty state). Read-only — no write gate.
- [ ] Wire `expertMemory` in `index.tsx` (`createExpertMemorySource({ profileRepo, documentRepo })`).
- [ ] Pre-push verify (test/lint/tsc, coverage 100%) → push → **STOP** (parent invokes Sentinel).

### PR-B — Export overlay (adapter + ExportOverlay) — `m8_prs: B`
- [ ] `test(tui)`: `tests/unit/tui/export-view.test.ts` — `createExportSource({ loadTranscript, renderMarkdown, renderJson, renderShare })` mapping `(panelName, format) → Promise<string>`; assert each `EXPORT_FORMATS` branch routes to the right renderer, an **unknown/empty transcript** path, and sanitization of the preview. Bite each format branch. RED-confirm.
- [ ] `feat(tui)`: `src/tui/adapters/export-view.ts` — pure `(transcript, format) → string` view source; 100% branch (no fs in the adapter).
- [ ] `ExportOverlay` (`.tsx`): a format picker (`markdown`/`json`/`share`) → preview → either copy-path or write-to-file (the file write lives in the screen via an injected `writeFile` dep so the adapter stays pure). Reachable from `SessionDetailScreen`. **Gate the write on loaded + `!inFlight`**; idle-gated Esc closes; sanitize the preview. Behavioral tests for each branch + the write-gate bite + Esc-close-with-back-stack bite.
- [ ] Wire `export` source + the overlay route/action in `index.tsx` / `routes.ts`.
- [ ] Pre-push verify → push → **STOP**.

### PR-C — First-run onboarding — `m8_prs: C`
- [ ] `test(tui)`: an onboarding adapter/source test — given an injected `isFirstRun` + a fake model-select source, assert the onboarding view shows when first-run, is skipped otherwise, and that confirming persists the chosen model via the injected writer (mirroring `selectModelInteractively`, no real fs/engine). Bite the first-run branch + the persist-on-confirm. RED-confirm.
- [ ] `feat(tui)`: an `onboarding` source + an `OnboardingScreen` (`.tsx`) shown when `loadConfigWithMeta().isFirstRun` — welcome + model pick. 100% branch on the `.ts` source.
- [ ] Wire in `index.tsx` / launch: when `isFirstRun`, route to onboarding before the home screen. Behavioral test via injected `isFirstRun`.
- [ ] Pre-push verify → push → **STOP**.

### PR-D — Tiered error display + startup warnings — `m8_prs: D`
- [ ] `test(tui)`: improve `ErrorBoundary` coverage — assert the fallback renders a sanitized, tiered message (a short headline + an expandable/secondary detail; i18n-ready string, no raw stack leaking unsanitized content) and that a thrown child is caught without crashing the app. Add a startup-warning surface test: given injected config-load warnings + an update notice, a banner/toast renders them (sanitized, dismissible). RED-confirm against the current minimal fallback.
- [ ] `feat(tui)`: enhance `ErrorBoundary` fallback (`src/tui/components/ErrorBoundary.tsx`) + a startup warning banner/toast component fed from `loadConfigWithMeta` warnings + `maybeNotifyUpdate`. Sanitize all surfaced strings. (Addresses the filed error-display follow-ups.)
- [ ] Wire the banner in `index.tsx` startup. Behavioral tests bite the catch + the warning render.
- [ ] Pre-push verify → push → **STOP**.

### PR-E — A11y / responsive + help-discoverability audit — `m8_prs: E`
- [ ] `test(tui)`: a contextual **help/legend** source surfacing each screen's key bindings (a per-route shortcut map → a sanitized legend view); assert it lists the right shortcuts per route and renders under `NO_COLOR`. Add responsive assertions: every 9.5–9.9 screen renders without crashing at `tooNarrow` (<60), `rail` (80), and `expanded` (≥120) widths, and respects `NO_COLOR`/`TERM=dumb`. Bite the per-route mapping. RED-confirm.
- [ ] `feat(tui)`: a help/legend overlay (resolves the help-discoverability cluster — surfaces per-screen shortcuts) + a sanitization/responsive sweep fixing any screen that mis-renders narrow or under `NO_COLOR`. (Folds in the filed `sentinel:*` help/a11y follow-ups where they fall in-scope.)
- [ ] Wire the help overlay (e.g. `?` keybinding) in `index.tsx` / AppShell. Behavioral + responsive tests.
- [ ] Pre-push verify → push → **STOP**.

### Closeout
- [ ] Docs closeout PR marking **9.9 ✅** in `plan.md` + the milestone tracker; file any new 🟡/🟢 from the milestone's Sentinel reports as `sentinel:*` issues.

## Sequencing & risk
PR-A and PR-B (adapter-leading, distinct files) parallelize off `main`. PR-C → PR-D → PR-E serialize (each touches `index.tsx` / AppShell startup wiring — rebase on the prior merge). Lowest-risk milestone of Phase 9 (read-only/local-file, no engine streaming); the only mutation is PR-B's optional export-to-file (gated + injected writer). Keep `main` green after every merge; clean stopping point after any PR. Per-PR tracker: SQL ledger `m8_prs`.
