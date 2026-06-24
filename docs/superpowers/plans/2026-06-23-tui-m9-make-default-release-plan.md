# Council TUI — Milestone 9.10 (M9 Make Default & Release) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **⚠️ GATED MILESTONE.** Three items here are **ASK FIRST / HUMAN REQUIRED** and MUST get explicit user sign-off before the PR is merged — even under autopilot: **PR-A (flip the default launch UX — a behavior/architecture change), PR-C (telemetry — env/network + opt-in semantics), and any release-automation change.** Implement and Sentinel-review them like any other PR, but PAUSE for explicit approval before the admin-merge of those three. PR-B/PR-D/PR-E are normal.

**Goal:** Make the TUI the default experience — bare `council` on an interactive TTY launches the full-screen UI (with a kept `--no-tui` / `COUNCIL_NO_TUI` escape and a clean non-TTY fallback to the CLI), add an explicit `council ui` command for discoverability, ship user-facing docs, opt-in TUI telemetry, and smoke/platform/perf QA — closing out Phase 9.

**Architecture:** The keystone is a tightened, pure `shouldLaunchTui` decision function (100% branch, exhaustive truth-table tests) that flips the default while keeping every escape hatch. Everything else is additive: a thin `council ui` command, a content-free opt-in telemetry sink gated on the existing `telemetry.enabled` flag, docs in `packages/site`, and CI smoke steps. No new engine surfaces.

**Tech Stack:** TypeScript ESM, Commander.js, Ink 7; Vitest; GitHub Actions (`platform-smoke.yml`); Astro docs (`packages/site`).

## Global Constraints (every task — the M0–M9 learnings)
- Node ≥ 24; ESM; **`.js` import specifiers**. Named exports only; explicit return types; `interface` for object shapes; `readonly` default; no `any`.
- **TDD (Sentinel-enforced):** `test(scope)` (RED-confirmed) precedes `feat(scope)`. Never combine. Docs-only / CI-only commits are TDD-exempt but still Sentinel-reviewed.
- **100% branch coverage** on `shouldLaunchTui` and any new `.ts` (telemetry sink, `ui` command logic) — exhaustive table tests before the feat commit. Tests ASSERT + **bite**.
- **Wiring inline** in `bin/council.ts` / `index.tsx` (coverage-exempt); pure decision/telemetry logic in tested `.ts`.
- Sanitize any user/env-derived string surfaced to the terminal (`toSingleLineDisplay`).
- **CI policy (hard):** every GitHub Actions `uses:` stays pinned to a full 40-char commit SHA with a trailing `# vX.Y.Z` comment — tag/branch pins are rejected by the repo. Do NOT hand-edit generated files (lockfiles, release CHANGELOG).
- **Per increment:** worktree off `main`; `pnpm install --frozen-lockfile`; `pnpm test`+`lint`+`typecheck` before PR; PARENT invokes Sentinel; delegated implementers STOP after opening the PR.

## Verified seams (against `main` 2026-06-23 — source of truth)
- **Launch gate** (`src/tui/lib/should-launch-tui.ts`): `shouldLaunchTui(argv: readonly string[], streams: LaunchStreams = {}): boolean`. Current logic, in order: a non-flag arg in `argv.slice(2)` (subcommand) → `false`; `stdout.isTTY !== true` → `false`; `CI` set & non-empty → `false`; `COUNCIL_NO_TUI` set & non-empty → `false`; else return `env["COUNCIL_TUI"] === "1"`. `LaunchStreams = { stdout?: { isTTY? }, env? }`. **The flip = replace the final line** so a TTY + no-subcommand + not-CI + not-`COUNCIL_NO_TUI` returns `true` by default, while `COUNCIL_TUI=1` stays an explicit force and `--no-tui` (a flag, so it does NOT count as a subcommand — must be checked explicitly) returns `false`.
- **Launch wiring** (`src/bin/council.ts`): `maybeLaunchTui(...)` is called before `buildProgram(...)`; bare `council` is intercepted there (no Commander root default action). `.version` + a TTY-gated help banner live in `buildProgram`. `COMMAND_CATEGORIES` groups commands for help.
- **Command factory pattern**: commands are `buildXCommand(deps = {}): Command` factories in `src/cli/commands/`, registered in `buildProgram` and grouped via `COMMAND_CATEGORIES`. The command-ordering test is `tests/unit/bin/council.test.ts` — **update it in the `test(scope)` commit** when adding `council ui`.
- **Telemetry**: `telemetry.enabled` defaults `false` (`src/config/schema.ts:54-59`, `:230`); `buildTelemetryCommand` exposes `status|enable|disable|explain` (content-free opt-in) (`src/cli/commands/telemetry.ts:14-69`). **There is NO event sink today** — a TUI telemetry API must be added, gated on `telemetry.enabled`, emitting only content-free counters (screen-view / feature-used), never user/model content.
- **CI**: `.github/workflows/platform-smoke.yml` builds + typechecks + runs CLI smokes (`--version`/`--help`/`templates`) on Ubuntu/macOS/Windows; a TUI smoke slots into the same matrix. `.github/workflows/ci.yml` is the required `Typecheck, Lint & Test` aggregate gate (Ubuntu, 4 unit shards + e2e/integration/security). Docs PRs are gated by `docs.yml` (astro build/check + command/config drift) — `packages/site` vitest is NOT in CI.
- **Docs**: user docs live in `packages/site/src/content/docs/`. The canonical persona example name is **Pedro Fuentes**. The docs site deploys to `https://pedrofuent.es/Council/` (do NOT add a CNAME in this repo).

## PR decomposition

### PR-A — Flip the default launch (behind a kept escape) — `m9_prs: A` — ⚠️ ASK FIRST (default-flip UX)
- [ ] `test(tui)`: extend `tests/unit/tui/should-launch-tui.test.ts` into an **exhaustive truth table** over { subcommand present?, `--no-tui` flag present?, `stdout.isTTY`, `CI`, `COUNCIL_NO_TUI`, `COUNCIL_TUI` } asserting the new default: TTY + no-subcommand + not-CI + no `--no-tui`/`COUNCIL_NO_TUI` → `true` (default ON); `--no-tui` or `COUNCIL_NO_TUI` → `false`; non-TTY → `false`; CI → `false`; any subcommand → `false`; `COUNCIL_TUI=1` still forces `true`. RED-confirm against the current `COUNCIL_TUI==="1"`-only logic. 100% branch.
- [ ] `feat(tui)`: update `shouldLaunchTui` to the new default + explicit `--no-tui` handling; update `maybeLaunchTui` arg parsing in `bin/council.ts` to recognize `--no-tui`. Keep `COUNCIL_TUI=1` as an explicit force for the transition.
- [ ] Pre-push verify → push → **STOP**. **Parent: get explicit user sign-off before merging** (this changes default UX).

### PR-B — `council ui` command — `m9_prs: B`
- [ ] `test(bin)`: a `buildUiCommand` test (launches the TUI explicitly via an injected launcher; offline) + **update the command-ordering test** `tests/unit/bin/council.test.ts` in this `test` commit to expect `ui` in its category slot.
- [ ] `feat(bin)`: `src/cli/commands/ui.ts` (`buildUiCommand(deps = {})`) that launches the TUI regardless of the default gate (for discoverability + when the default is off); register in `buildProgram` + `COMMAND_CATEGORIES`.
- [ ] Pre-push verify → push → **STOP**.

### PR-C — Opt-in TUI telemetry — `m9_prs: C` — 🚨 HUMAN REQUIRED (telemetry / env / network)
- [ ] `test(tui)`: a telemetry-sink adapter test — gated on `telemetry.enabled`; when disabled, emits NOTHING (assert the injected sink is never called); when enabled, emits only content-free counters (screen-view/feature-used — assert NO user/model content in the payload). Bite the enabled/disabled branches. 100% branch.
- [ ] `feat(tui)`: a minimal content-free telemetry event API (likely a local no-op counter first; any network emission stays behind the opt-in) wired into the TUI; respects the existing `telemetry status|enable|disable|explain`.
- [ ] Pre-push verify → push → **STOP**. **Parent: HUMAN REQUIRED — surface for explicit approval before merging any telemetry emission.** Ship as a local no-op counter unless the user approves network emission.

### PR-D — TUI user docs — `m9_prs: D`
- [ ] `docs`: user-facing docs in `packages/site/src/content/docs/` covering launch (default-on + `--no-tui` / `COUNCIL_NO_TUI` / `council ui`), and the panel / expert / chat / convene / conclude flows + env vars. Use **Pedro Fuentes** for any persona example. Resolves the docs-discoverability cluster.
- [ ] Verify with the docs gate locally: `pnpm --filter @council-ai/site... docs:check:commands` / `:config`, `astro build`, `astro check`. Push → **STOP**.

### PR-E — Smoke / platform / perf QA — `m9_prs: E`
- [ ] `ci`: add a non-TTY **TUI-fallback** smoke (bare `council` with `stdout` not a TTY → falls back to CLI help, exit 0) + a `--no-tui` smoke to `platform-smoke.yml` across Ubuntu/macOS/Windows. Keep every `uses:` SHA-pinned + `# vX.Y.Z`.
- [ ] A perf/startup-time sanity check (TUI cold-start within a sane budget) + a final cross-platform pass. Push → **STOP**.

### Closeout
- [ ] Docs closeout PR marking **9.10 ✅** and **Phase 9 COMPLETE** in `plan.md` + the tracker; file any residual 🟡/🟢 as `sentinel:*` issues. Confirm bare `council` on a TTY now opens the TUI and `--no-tui`/non-TTY still get the CLI.

## Sequencing & gates
PR-A (the keystone) lands first so the default UX is correct before docs describe it; PR-B/C/D/E follow. PR-A, PR-C, and any release-automation change are **ASK FIRST / HUMAN REQUIRED** — implement + Sentinel-review them, but PAUSE for explicit user approval before their admin-merge. Keep `main` green after every merge. Per-PR tracker: SQL ledger `m9_prs`. This milestone completes Phase 9.
