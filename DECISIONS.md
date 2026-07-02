# Architecture Decision Records — Council

> **Record every significant technical decision here.** When choosing between approaches,
> document what was chosen and why. This prevents future agents and developers from
> re-debating settled decisions or accidentally reversing them.
>
> Do NOT write decisions to AGENTS.md — they belong here.

## Format

```markdown
### ADR-NNN: Decision Title
**Date**: YYYY-MM-DD
**Status**: Proposed / Accepted / Superseded by ADR-NNN
**Context**: What problem or question prompted this decision?
**Decision**: What was decided?
**Alternatives considered**: What other options were evaluated?
**Consequences**: What are the trade-offs? What does this enable or prevent?
```

## Decisions

<!-- Add new decisions below this line, most recent first -->

### ADR-030: `--format auto` resolves the renderer from TTY; explicit `plain`/`json` override it
**Date**: 2026-07-02
**Status**: Accepted
**Context**: The streaming debate commands (`convene`, `resume`, `ask`, `review`) share one `--format auto|plain|json` flag (default `auto`; `RENDERER_FORMATS` in `packages/cli/src/cli/renderers/select.ts`). `auto` must give humans the rich Ink TUI in a terminal while staying safe for pipes, CI, logs, and accessibility tooling — where TUI cursor motion, resize reflow, and ANSI framing corrupt captured output. Two behaviors were encoded only in code comments and never documented for users: (1) how `auto` picks a concrete renderer, and (2) that `council resume` transcript replay silently coerces `auto`→`plain` (`resume.ts`: "auto degrades to plain — Ink would just render a static dump"). Issue #237 asked for both — plus the piped-output determinism guarantee — to be written down.
**Decision**: `selectRenderer()` (`renderers/select.ts`) maps `--format` to a renderer as follows: `json`→`JsonRenderer` and `plain`→`PlainRenderer` **always**, regardless of TTY; `auto`→`InkRenderer` only when stdout is a TTY **and** no accessibility/CI override is active (`shouldForcePlain()`: `TERM=dumb`, `CI=true|1`, or `ACCESSIBILITY=1`), otherwise `PlainRenderer` with color disabled. Only `auto` consults `process.stdout.isTTY`; an explicit `--format plain|json` is never overridden by TTY detection, so piped/redirected output stays deterministic and `--format json` stays pure NDJSON (one event per line). `council resume <panel>` transcript replay treats `auto` as `plain` (`transcriptFormat = format === "json" ? "json" : "plain"`) because a completed transcript is a static dump the TUI cannot animate; `--format json` still yields NDJSON.
**Alternatives considered**:
- **Let `auto` pick Ink even for transcript replay** — rejected: Ink would render a one-shot static frame with no interactivity benefit while risking scrollback/ANSI artifacts in redirected transcripts.
- **Make `plain`/`json` also consult TTY** — rejected: that reintroduces the non-determinism the explicit flags exist to remove; scripts and CI could silently get a different renderer.
- **A separate `--tui`/`--no-tui` boolean** — rejected: a single tri-state `--format` is simpler and already aligns with the JSON output path.
**Consequences**:
- ✅ Users can rely on a documented contract: `auto` = TUI-on-TTY, while `plain`/`json` stay stable across terminals, pipes, and CI.
- ✅ `--format json | jq` and redirected NDJSON stay parseable; CI (`CI=true`) and `TERM=dumb`/`ACCESSIBILITY=1` sessions transparently fall back to plain text.
- ✅ `resume` transcript replay is predictable (plain unless `json` is requested). The `auto`→`plain` coercion is already exercised by `resume.test.ts` ("plain transcript: prints panel header, all turns in order, debate status"), which invokes `council resume <panel>` with the default `--format auto` and asserts plain-text transcript output rather than the Ink TUI.
- ⚠️ The `auto`→`plain` transcript coercion is intentional; "fixing" resume to honor Ink for replay would regress this decision.

### ADR-029: Enforce `maxWordsPerResponse` as a soft per-turn prompt nudge
**Date**: 2026-06-21
**Status**: Accepted
**Context**: `maxWordsPerResponse` (CLI `--max-words`, default 250) was fully plumbed — flags on `convene`/`ask`/`review`/`resume`, schema validation (50–2000), the config wizard, `config show/set`, and persisted into `DebateConfig` — but it **never reached the model**. It was declared in `DebateConfig` (debate.ts) and `CostInput` (cost.ts) yet read nowhere in prompt construction or cost math, so tightening it did nothing. This was not merely dead config: `error-mapper.ts` advises users to *"Try a smaller `--max-words`"* to escape `CONTEXT_OVERFLOW`, a remedy that was a no-op. Commit `45216c9` already documented the gap (a Sentinel finding renamed the `--max-words` e2e test to "command accepts flag and completes" because "MockEngine doesn't enforce limits"). `chat` intentionally passes `0`.
**Decision**: Enforce the budget as a **soft prompt nudge**, not a hard truncation. A pure `appendWordBudget(task, maxWords)` helper (`core/word-budget.ts`) appends a length target plus a quality clause ("…do not drop your strongest disagreement or a specific, falsifiable claim just to hit the target"). It is applied at the single AI-turn chokepoint `Debate.#runAiTurn`, **after** the `[REFERENCE DOCUMENTS]` block, so it covers both freeform strategies and structured phases in one place and is always the final instruction. A non-positive budget is the "no cap" sentinel (`chat` → `0`). The default stays **250**.
**Alternatives considered**:
- **Remove the flag/config as dead surface** — rejected: `error-mapper` advertises it as a remedy; a word budget is on-brand with the prompt-architecture thesis ("constraints produce intelligence"); and enforcing is cheaper than ripping flags out of 5 commands + schema + wizard + error text.
- **Inject into the system prompt's OUTPUT CONTRACT** — rejected: the system prompt is built once at convene time and **persisted**; `ask`/`resume` replay it (ask.ts:245, resume.ts:180), so a cap there would be static-per-panel and still ignore per-invocation `--max-words`. Only the per-turn task is rebuilt each run.
- **Hard truncation / post-hoc trimming** — rejected: cuts experts mid-argument and fights the quality-gate's 12-word floor and the falsifiability contract.
- **Per-phase budgets** (opening ~250–300 / rebuttal ~150–200 / synthesis ~300–400, per the architecture doc and research) — deferred as a future enhancement; V1 applies a uniform budget.
**Why 250**: from `docs/analysis/03-prompt-architecture.md` ("250 words/expert/turn", "Length is not depth") and the deliberation literature — Khan et al. 2024 (arXiv:2402.06782) cap debaters at 150 words/turn to curb LLM verbosity bias; human-preferred Q&A answers run 125–175 words; concision instructions don't measurably hurt non-math/deliberative quality. Soft framing + the paired quality clause matter more than the exact number.
**Consequences**:
- ✅ `--max-words` now actually shortens expert responses on `convene`/`ask`/`review`/`resume`, and the `error-mapper` `CONTEXT_OVERFLOW` advice is finally true.
- ✅ `chat` stays uncapped via the `0` sentinel; the persisted system prompt is untouched.
- ⚠️ Soft nudge: adherence is best-effort. Budgets below ~100 words tend to be **ignored** by the model (token-elasticity, arXiv:2412.18547). The schema floor stays `50` (`min`) for compatibility, but this caveat is documented here rather than enforced.
- 📝 Existing site docs already describe `--max-words` as a "soft cap", so no doc correction was needed. Follow-ups: per-phase budgets; optionally drop the unused `CostInput.maxWordsPerResponse` field (cost = premium requests = turn count, word-independent).

### ADR-028: Keep `@council-ai/cli` canonical; unscoped `council-ai` is a deprecated placeholder
**Date**: 2026-06-20
**Status**: Accepted (extends ADR-025)
**Context**: Visiting `npmjs.com/package/@council-ai` returns 404 — bare scopes have no npm page, which is true of every scoped package (`@angular`, `@aws-sdk`, `@nestjs`). A proposal (Option R) to rename the CLI to the unscoped `council-ai` (the `expo`/`vercel` "unscoped canonical + scoped internals" model) was implemented and reviewed in PR #1302, then **closed**: Sentinel flagged that the renamed self-update target (`council update` → `council-ai@latest`, plus the version-probe URL) pointed at an **unowned** npm name. Owning the `@council-ai` **org** reserves only the `@council-ai/*` **scope**, not the separate unscoped `council-ai` name (verified 404), so shipping that code was a dependency-confusion/supply-chain risk. Council is also multi-surface (CLI + web + core), which makes the `@council-ai/*` scope the natural umbrella rather than committing the bare brand name to mean "the CLI".
**Decision**: Keep **`@council-ai/cli`** as the single canonical published package (binary `council`); do **not** rename. Separately publish the unscoped **`council-ai`** as a **deprecated placeholder** — source in `packaging/council-ai/`, deliberately **outside** the pnpm workspace (`packages/*`) so it never affects install/build/test. It is metadata-only (no `bin`, no code, `files: ["README.md"]`); its README points users to `@council-ai/cli`. It is published once by a human and then `npm deprecate`d with a redirect message. This gives `npmjs.com/package/council-ai` real content, defends the brand, and closes the typosquat/supply-chain hole — with **zero** change to `@council-ai/cli`, CI, release-please, or Trusted Publishing.
**Alternatives considered**:
- **Rename to unscoped `council-ai` (Option R)** — rejected: requires owning/maintaining a new canonical namespace, a self-update migration bridge, a Trusted-Publisher re-point, and a download-stat reset; commits the bare brand to "the CLI" as the web/core surfaces grow (PR #1302, closed).
- **Live functional alias** (`council-ai` that depends on and forwards to `@council-ai/cli`) — rejected: essentially unprecedented and fights the built-in `council update` (would shadow the `council` bin / cause double global installs).
- **Do nothing (accept the 404)** — viable, but leaves the unscoped `council-ai` open to typosquatting and provides no content page.
**Consequences**:
- ✅ Zero change to the working `@council-ai/cli` package, CI, release pipeline, or Trusted Publishing.
- ✅ `npmjs.com/package/council-ai` shows a redirect README and the name is owned (no typosquat/supply-chain exposure).
- ⚠️ The placeholder must be `npm publish`ed and `npm deprecate`d by a human (HUMAN REQUIRED / ASK FIRST); it is kept minimal so it never needs version maintenance.
- 📝 The no-hyphen `councilai` variant needs **no** placeholder: once `council-ai` is published, npm's package-name **similarity guard** rejects publishing `councilai` (`403 — too similar to existing package council-ai`), so the typo is auto-defended and the name is unclaimable by anyone. A `packaging/councilai/` placeholder was briefly added (#1304) and then **removed** when the publish was blocked — see LEARNINGS.md [2026-06-20].

### ADR-027: SQLite backend = Node's built-in `node:sqlite`, not `@libsql/client`
**Date**: 2026-06-20
**Status**: Accepted (supersedes ADR-005; ADR-002's orchestration-index role unchanged)
**Context**: ADR-005 chose `@libsql/client` + `@libsql/kysely-libsql` on the premise that it was "pure JavaScript / WebAssembly … no native build, no prebuilds." That premise was **incorrect**: the Node entry point of `@libsql/client` loads the **native** `libsql` addon, which selects a per-platform prebuilt binary via `optionalDependencies`. `libsql` publishes prebuilts for darwin (x64/arm64), linux (x64/arm64, gnu+musl), and **win32-x64 only** — there is **no `@libsql/win32-arm64-msvc` at any version** (`libsql@0.5.29`'s `neon.targets` has no `aarch64-pc-windows-msvc`). On Windows-on-ARM the optional dep is silently skipped at install and `council` crashes at startup: `Cannot find module '@libsql/win32-arm64-msvc'` (reported on a fresh Node 25 arm64 machine). So ADR-005 did not actually escape the native-prebuild risk it was created to avoid (better-sqlite3's missing Node-version prebuild) — it shifted it from a Node-version gap to a platform gap.
**Decision**: Use Node's built-in **`node:sqlite`** (`DatabaseSync`) as the SQLite backend, driven through an in-repo Kysely dialect (`packages/cli/src/memory/node-sqlite-dialect.ts`) that reuses Kysely's `SqliteAdapter` / `SqliteIntrospector` / `SqliteQueryCompiler` and adapts only the driver/connection (node:sqlite passes bound params as spread args and has no `stmt.reader`, so read-vs-write is derived from `stmt.columns().length`). `node:sqlite` ships inside Node, so persistence is dependency-free and platform-independent (works on Windows ARM64) and bundles FTS5. It is available unflagged from Node 24+, so the minimum Node was raised to `>=24.0.0`. Removed `@libsql/client` and `@libsql/kysely-libsql`.
**Alternatives considered**:
- **Upgrade `libsql`** — rejected: no win32-arm64 prebuilt exists at any version.
- **Keep `libsql`; document running x64 Node under Windows-ARM emulation** — rejected: pushes a platform workaround onto users; violates "simple to run".
- **`better-sqlite3`** — rejected (the original ADR-005 blocker): native, reintroduces the missing-prebuild risk.
- **`node-sqlite3-wasm`** — rejected: pure WASM but a smaller community and no first-party Kysely dialect.
**Consequences**:
- ✅ Eliminates the entire "missing prebuilt binary" failure class — `node:sqlite` is part of the Node runtime; `pnpm install` needs no native toolchain.
- ✅ Zero native/runtime dependencies for persistence.
- ⚠️ Minimum Node is now 24 (`node:sqlite` is flagged on Node 22). It is still marked "experimental" by Node, but Node 24 is LTS and Council uses only basic SQL execution; the `ExperimentalWarning` is suppressed by `packages/cli/src/bin/sqlite-warning-filter.ts` (now load-bearing).
- ⚠️ Drops the "same code path → Turso cloud (`libsql://`) for Phase 5" alignment ADR-005 noted; a future hosted-persistence path would reintroduce an HTTP/libsql client behind the existing `CouncilDatabase` Kysely seam.
- 📝 Follow-ups tracked: #1259/#1260/#1261 (dialect coverage + robustness), #1265–#1269 (minor cleanups). The AGENTS.md tech-stack line still says `@libsql/client` — HUMAN REQUIRED to edit; `packages/cli/package.json` is the source of truth.

### ADR-026: npm OIDC Trusted Publishing + provenance for `@council-ai/cli`
**Date**: 2026-06-18
**Status**: Accepted
**Context**: A long-lived `NPM_TOKEN` stored in GitHub Actions secrets is a standing secret/rotation burden and a supply-chain risk. npm supports OIDC Trusted Publishing (keyless, short-lived tokens exchanged at publish time), eliminating the need to store any npm credential in steady state.
**Decision**: The release pipeline uses `.github/workflows/release-please.yml`, which runs both the `release-please` job (creates the tag + GitHub Release on a merged release PR) and a **gated `publish` job** in the same push-triggered run (chained on `releases_created == true`). The publish job uses the `npm-publish` GitHub environment (required reviewer approval gate), requests `id-token: write`, and passes `--provenance` to attach a SLSA Level 2 attestation. No `NPM_TOKEN` is stored in repository secrets. The `0.1.0` bootstrap (first publish, required to register the OIDC link on npm) is a one-time manual step documented in `RELEASING.md`; `0.1.1` was the first automated provenance release. `@council-ai/cli` ships ESM-only (`type: module`; exports expose only `import`), so `packages/cli/.attw.json` suppresses the inherent `cjs-resolves-to-esm` attw rule by design — not a misconfiguration (#1182).
**Alternatives considered**:
- **Long-lived `NPM_TOKEN`** — rejected: stored secret, requires rotation, exploitable if leaked.
- **Granular access token (npm `automation` type)** — mitigates scope but still a stored secret; OIDC is strictly better when npm supports it.

**Consequences**:
- Zero stored npm secrets in steady state — token exchange happens at publish time via GitHub OIDC.
- The `0.1.0` bootstrap publish lacks provenance (manual); all subsequent CI-published versions carry SLSA Level 2 attestation.
- Requires one-time npm org configuration (trusted publisher link) before the first CI publish.
- The publish is chained as a job inside the push-triggered `release-please.yml` run (not via a separate `on: release: published` workflow) because GitHub does not trigger new workflow runs from events initiated by the default `GITHUB_TOKEN`; a `workflow_dispatch` manual fallback exists. Each publish is guarded by the `npm-publish` environment approval gate (required reviewer), preventing accidental or automated publishes.

### ADR-025: npm namespace `@council-ai` and pnpm monorepo structure
**Date**: 2026-06-18
**Status**: Accepted
**Context**: Phase 8 (Growth & Ecosystem) requires publishing Council to npm. Two questions had to be settled before the first publish: (1) which npm name/namespace to claim — the unscoped `council` name and the bare `councilai` are effectively unavailable/ambiguous, and a scoped name gives us a stable org for future packages; and (2) how to lay out the repository so additional surfaces (a shared core engine, a future web UI) can be developed and versioned without coupling them to the CLI's release cadence. The codebase was previously a single top-level package (`src/`, `tests/`, `panels/` at the repo root), which leaks internal paths into the published tarball and blocks independent packages.
**Decision**:
1. **npm namespace** — publish the CLI as the scoped package **`@council-ai/cli`** (binary: `council`) under the **`@council-ai`** npm organization. The unscoped **`councilai`** name is reserved (claimed defensively) but is **not** used for publishing — all packages live under the `@council-ai` scope. Published with npm **provenance** (`publishConfig.provenance: true`) via the OIDC publish workflow.
2. **Monorepo structure** — convert to a **pnpm workspace** (`pnpm-workspace.yaml` → `packages/*`). The publishable CLI lives in **`packages/cli/`** (`@council-ai/cli`). Two private placeholders reserve names for future extraction: **`packages/core/`** (`@council-ai/core`, `private: true` — shared deliberation engine/domain types, not yet extracted) and **`packages/web/`** (`@council-ai/web`, `private: true` — browser interface, not yet implemented). Only `packages/cli/` is published; the placeholders are `private` so they can never be accidentally released.
3. **ESM-only type-checking** — `packages/cli` ships ESM-only and uses `@arethetypeswrong/cli` (`attw`) + `publint` in `prepublishOnly` to verify the published types/exports resolve correctly for consumers (ref [#1182](https://github.com/pedrofuentes/Council/issues/1182)). An `.attw.json` configuration documents the ESM-only resolution expectations so CJS-resolution warnings are not treated as failures.

**Alternatives considered**:
- **Unscoped `council` / `councilai` as the primary published name** — rejected: unscoped names are unavailable or ambiguous, and a scope gives a stable home for `core`/`web`. `councilai` is held as a reservation only.
- **Single top-level package (no monorepo)** — rejected: blocks independent versioning of a future core engine and web UI, and leaks repo-root paths into the published tarball.
- **Separate repositories per package (polyrepo)** — rejected as premature: a workspace keeps shared tooling/CI in one place and lets `core` be extracted incrementally without a repo split.
- **Publishing `core`/`web` immediately** — rejected: nothing is extracted/implemented yet; publishing empty packages pollutes the registry. They stay `private` placeholders until real code lands.

**Consequences**:
- The published install command is `npm install -g @council-ai/cli`; docs/planning references use the scoped name consistently.
- `packages/cli/` owns its own `README.md` (npm-facing), `LICENSE`, and `CHANGELOG.md`; the root `README.md` is the monorepo/project overview.
- All `src/…` and `tests/…` paths in architecture/testing docs are now relative to `packages/cli/`.
- Future engine/web work has a reserved name and a place to live without a CLI release bump.
- Provenance + `attw`/`publint` gating raises publish confidence but adds a `prepublishOnly` build/verify step.

### ADR-024: AI-extraction workflow modes — `off`, `ask`, `auto`
**Date**: 2026-06-17
**Status**: Accepted
**Context**: Document extraction expanded from 3 text formats (`.md`, `.txt`, `.html`) to 13+ binary/structured formats (PDF, DOCX, PPTX, XLSX, CSV/TSV, RTF, ODT/ODS/ODP). Some formats (e.g., password-protected PDFs, corrupt DOCX) can fail extraction or produce unusable output. This required a policy decision: should Council auto-extract all eligible files immediately, prompt the user per-file, or skip extraction entirely?
**Decision**: Introduced `documents.aiExtraction` config with three modes:
- **`off`** (default): Skip AI extraction entirely. Index only plaintext/markdown. Binary files are marked `needs_review` but never processed. Use case: users who want full control or are concerned about local LLM/API costs.
- **`ask`**: Eligible files are marked `needs_review` and held for user approval. The user runs `council docs extract` to batch-process them after review. Use case: cautious users who want to see what will be extracted before committing to the AI call.
- **`auto`**: Eligible files are extracted and indexed immediately on add/refresh. Use case: power users who trust the heuristic and want zero friction.

Eligibility is centralized in `isExtensionAiEligible` (exported from `src/core/documents/extractors/ai-fallback.ts`): PDFs, Office formats, iWork, OpenDocument, RTF, images. The AI fallback (when extraction fails) builds a LOCAL structured description (filename, size, type, context) — no external AI/SDK call, so it's safe and deterministic.

**Alternatives considered**:
- **Always auto-extract (no opt-out)** — rejected: some users may not want to incur LLM API costs or latency for every binary file. Council should be usable with zero AI calls for extraction if the user prefers.
- **Per-file prompt (blocking)** — rejected: interrupts workflow for bulk adds (`council docs add ./reports/*.pdf`). The `ask` mode + batch `council docs extract` is non-blocking and allows review.
- **External AI call for fallback descriptions** — rejected: fallback is a last-resort error path; it should not introduce new external dependencies or costs. The local structured description is sufficient for basic discoverability.
- **Hardcoded extraction policy per format** — rejected: users have different risk tolerances. A research team may want auto-extract for PDFs; a legal team may want `ask` for everything. The config makes it their choice.

**Consequences**:
- ✅ Users can tune extraction aggressiveness to their workflow (zero friction vs full control).
- ✅ `off` (default) is safe for first-time users: no surprise AI calls, no accidental indexing of sensitive binary content. `ask` adds a review step before any extraction.
- ✅ Single source of truth for eligibility: `isExtensionAiEligible` is reused by `doctor --models`, the refresh logic, and the extraction command.
- ✅ Fallback descriptions are free (no SDK call) and always available, so even `off` mode users get basic metadata for binary files.
- ⚠️ `auto` mode may extract large or corrupt files that produce poor results. Acceptable trade-off: power users can always re-run `council docs remove` + `add` if needed.
- 📝 Future extension: per-directory extraction policies (`./public-reports/` auto, `./drafts/` ask) could be layered on top of the global mode. Deferred until user demand surfaces.

### ADR-023: Node 22+ requirement due to `@github/copilot-sdk` subprocess dependency on `Promise.withResolvers`
**Date**: 2026-06-17
**Status**: Accepted (Node floor later raised to ≥24 by ADR-027; Node 24 still satisfies this ≥22 constraint)
**Context**: Council's `package.json` originally specified `"engines": { "node": ">=20.0.0" }` based on TypeScript ES2022 compilation target and the assumption that the Copilot SDK would be compatible with Node 20 LTS. During PR #1145, CI intermittently failed with `[CLI subprocess] TypeError: Promise.withResolvers is not a function`. Investigation (issue #1138) revealed the root cause: the `@github/copilot-sdk` package spawns a CLI subprocess (via `CopilotClient.start()`) that uses `Promise.withResolvers`, an ES2024 feature available only in Node 22+. Even though Council's own code compiles to ES2022, the SDK's runtime subprocess requirement forced a hard floor.
**Decision**: Bump `engines.node` to `>=22` in `package.json`, set the CI `node-version` to `22`, and document Node 22+ as a hard requirement in README.md. Council can no longer run on Node 20, regardless of transpilation target. (Implemented in PR #1149.)
**Alternatives considered**:
- **Polyfill `Promise.withResolvers` in the subprocess** — rejected: the subprocess is owned by `@github/copilot-sdk`, not Council. We cannot inject polyfills into a third-party CLI binary.
- **Vendor/fork the SDK and downgrade its code** — rejected: unsustainable maintenance burden. The SDK is actively developed; staying on a fork diverges from upstream security patches and feature updates.
- **Support dual Node 20/22 environments with runtime detection** — rejected: the SDK subprocess would still fail on Node 20. No way to work around it without forking the SDK.
- **Wait for Node 20 to reach EOL and require Node 22 anyway** — this aligns with the eventual timeline, but the SDK forced the decision early.
**Consequences**:
- ✅ CI failures eliminated: no more intermittent `Promise.withResolvers is not a function` errors.
- ✅ Aligns with modern Node LTS: Node 22 is the current LTS as of mid-2026; requiring it is forward-compatible.
- ⚠️ Users on Node 20 must upgrade. This is a breaking change for the (small) existing user base. Documented in CHANGELOG.md as a major version bump if/when Council reaches v1.0.
- ⚠️ CI matrix now runs only Node 22. If we want to test forward compatibility with Node 24+, we must add it explicitly to the matrix. (Deferred until Node 24 LTS stabilizes.)
- 📝 README.md, installation docs, and error messages must reflect the Node 22+ requirement. An explicit version check in the CLI entrypoint (e.g., `process.versions.node < 22` → friendly error) would improve UX. (Issue #1138 tracks this as a follow-up.)

### ADR-022: Model list single source of truth — `src/engine/models.ts` as canonical, derived everywhere else
**Date**: 2026-06-17
**Status**: Accepted
**Context**: Council supports multiple AI models (Sonnet, Opus, Haiku, GPT, Gemini) across several user-facing surfaces: `council models` command, `convene --model` validation, `doctor --models` health check, and the first-run wizard. Before PR #1125, these surfaces each hardcoded their own model lists, leading to drift: the `models` command listed 8 models, `convene --model` validated 7, and `doctor` checked 6. Adding a new model required changes in 4+ places, with no compile-time enforcement. Issue #1131 raised the question of live-discovery vs static reconciliation (querying GitHub for available models at runtime); the static approach was chosen but required a single source of truth.
**Decision**: `src/engine/models.ts` exports `SUPPORTED_MODELS` (array of `ModelInfo` objects) and `isSupportedModel(id: string): boolean` as the canonical model registry. All other surfaces derive from it:
- `council models` → iterates `SUPPORTED_MODELS`, renders as table
- `convene --model` validation → calls `isSupportedModel(userInput)`
- `doctor --models` → iterates `SUPPORTED_MODELS`, pings each
- First-run wizard → maps `SUPPORTED_MODELS` to Ink select choices

No other file may hardcode a model ID list. ESLint rule or grep check enforces this (deferred to issue #1131 follow-up).

**Alternatives considered**:
- **Live-discovery via GitHub Copilot API** — rejected for v0: requires network call on every `council models` invocation, slower UX, and the API may not expose model metadata (context window, pricing tier, deprecation status). Revisit in Phase 4 (Cloud integration) when we have a models endpoint.
- **YAML/JSON config file for models** — rejected: adds indirection without benefit. TypeScript source is already structured (`ModelInfo` interface), type-safe, and diff-friendly. A config file would need a loader, validator, and error handling for malformed JSON.
- **Separate lists per command, checked via tests** — rejected: tests are too late in the feedback loop (they run post-commit). If a dev adds a model to `models.ts` but forgets `convene.ts`, the test fails in CI but the PR is already written. Centralization prevents the bug at authoring time.
- **Auto-generate `models.ts` from an external source** — considered but deferred to #1131: if GitHub eventually provides a models API, we could generate `models.ts` via a build script. For now, manual updates are acceptable (models change infrequently).

**Consequences**:
- ✅ Adding a new model requires exactly one change: add to `SUPPORTED_MODELS` in `models.ts`. All commands, validators, and help text update automatically.
- ✅ Type safety: `ModelInfo` interface enforces required fields (`id`, `name`, `family`, `tier`). Missing or malformed entries fail at compile time.
- ✅ Self-documenting: the `models.ts` file is the authoritative reference for "what models does Council support?" Any dev or reviewer can check one file.
- ⚠️ No compile-time enforcement yet: a dev could still hardcode a model ID in a new command without realizing the convention. Mitigated by (1) code review (Sentinel checks imports), (2) a future ESLint rule (`no-restricted-syntax` for string literals matching model ID patterns), and (3) grep in CI (`rg '"(claude|gpt|gemini)-' src/ --type ts | grep -v models.ts` fails if non-`models.ts` files hardcode model IDs). Issue #1131 tracks the lint rule.
- 📝 Future: if/when GitHub exposes a models API, `models.ts` can become a generated file (build-time fetch + codegen). The public API (`isSupportedModel`, `SUPPORTED_MODELS`) remains unchanged, so no breaking change for consumers.

### ADR-021: Shell-mangling of free-text args — `--prompt-file` as bulletproof input + source-aware warnings (PM-02)
**Date**: 2026-06-17
**Status**: Accepted
**Context**: Users invoke `council convene "prompt text"` and `council ask "question"` with free-text arguments. Shells (Bash, Zsh, PowerShell, cmd.exe) apply their own expansion rules before passing `argv` to Node.js: variable interpolation (`$VAR`, `%VAR%`), glob expansion (`*.txt`), quote removal, escape-sequence processing. This is unrecoverable from the CLI's perspective — by the time Council sees `process.argv`, the shell has already mangled the input. Examples:
- PowerShell: `council convene "I have $180K budget"` drops `$180K` (undefined variable).
- Bash: `council convene files: *.md` (unquoted) expands `*.md` to the matching filenames before Council sees `argv`; double-quoting (`"*.md"`) prevents the expansion.
- Windows cmd.exe: `council ask "cost %BUDGET%"` expands `%BUDGET%` (to its value, or strips it if undefined) even inside double quotes.

This is a fundamental UX hazard for a CLI that accepts free-text human input. Users expect verbatim pass-through but shells don't provide it. Problem PM-02 in the project backlog tracked this as a "shell-safe input method" requirement.

**Decision**: Three-part mitigation strategy:
1. **Bulletproof input channel: `--prompt-file <path|->`.** Accepts a file path or `-` for stdin. Reads the prompt verbatim (no shell expansion). This is the escape hatch for any input that might trigger shell parsing (e.g., contains `$`, `*`, `\`, newlines). Implemented in `convene` and `ask` commands (PR #1145).
2. **Source-aware heuristic warnings.** Detect likely shell-mangling residue (double spaces, lone unit-suffix like "K budget", "M records") and warn the user — but ONLY for `source="arg"`. Interactive chat input and `--prompt-file`/stdin never warn (they can't be shell-mangled). Warning includes a suggestion to use `--prompt-file` or stdin. Uses word-boundary matching to avoid false positives (e.g., "KEY" or "OK" are valid words, not residue).
3. **Confirm-on-detect for interactive arg input.** If the user runs `council convene "prompt with $ or residue"` (not `--non-interactive`), the heuristic fires, and the command shows a confirm prompt with the sanitized (single-line) echo: "You entered: [preview] — proceed?" This gives the user a chance to abort and re-run with `--prompt-file`. (PowerShell and cmd.exe are semi-interactive terminals; confirm is appropriate.)

**Alternatives considered**:
- **Block all shell-sensitive characters in args** — rejected: too restrictive. `$` and `*` are valid in natural language (budgets, emphasis, bullet points). The CLI would be unusable for many legitimate prompts.
- **Auto-detect shell and re-quote** — rejected: Node.js doesn't expose the parent shell type reliably. Even if we could detect PowerShell vs Bash, re-quoting is a losing battle — we'd need to predict and reverse every shell's expansion rules, which are context-dependent (e.g., glob expansion depends on directory contents).
- **Warn on every arg input** — rejected: too noisy. Most prompts are safe. The heuristic targets high-signal patterns (residue that strongly suggests mangling).
- **Require `--prompt-file` for all input** — rejected: degrades UX for simple prompts. `council ask "quick question"` is convenient and usually safe. The escape hatch should be opt-in.
- **Store the raw shell command in history and re-execute** — rejected: requires shell integration (trap, history hooks). Brittle and platform-specific.

**Consequences**:
- ✅ Users with shell-mangled prompts have a clear, documented escape hatch: `--prompt-file` or stdin redirection (`council convene --prompt-file - < prompt.txt`).
- ✅ Heuristic warnings catch ~80% of common mangling cases (based on testing with PowerShell `$VAR` and glob expansion). Low false-positive rate due to word-boundary matching.
- ✅ Interactive confirm provides a safety net: user sees a preview of what Council received and can abort if it's wrong.
- ⚠️ Does not solve the underlying problem (shell expansion). Users must still learn to use `--prompt-file` for complex input. Acceptable trade-off: every CLI with free-text args has this issue; we're providing better mitigation than most.
- ⚠️ Heuristic is imperfect: cannot detect all mangling (e.g., single-space collapse, quote removal). Documented in `--help` and README with examples.
- 📝 Future enhancement: `council config set input.default_source file` could make `--prompt-file` the default, with `--arg` to opt into shell-parsed args. Deferred until user feedback confirms demand.

### ADR-020: Promote sessions to library panels via `panel save` (suffix on name collision)
**Date**: 2026-06-15
**Status**: Accepted
**Context**: `council convene <topic>` without `--template` auto-composes a panel, but that panel exists only as a timestamped *session* (visible in `council sessions`) — it is never written to the reusable library, so `council panels` shows "No panels found" and users cannot `council chat` with a panel they just convened. The composed expertise was discarded after each run. Closing this gap (T9) required two sub-decisions: (1) where to store the data needed to reconstruct a library panel from a session, and (2) what to do when a promoted panel name or expert slug already exists in the library.
**Decision**:
- **Enabler (no migration)**: at convene time, persist the full `ResolvedPanelDefinition` (structured experts: slug/role/expertise/epistemicStance + defaults) as JSON under a new `definition` key inside the session's existing `panels.config_json` column. No schema change — `config_json` is already free-form JSON, and existing readers key off `template`/`mode`/`engine`, which are untouched.
- **New opt-in command** `council panel save <session> [name]` (also `--latest`) reads that stored definition and promotes the session into a real library panel + experts, reusing `FileExpertLibrary.create` and the exact `panel create` write path (extracted into a shared `persistPanelArtifacts` helper). Session resolution reuses `resolveSession` (exact / unique-prefix / `--latest`), consistent with `resume`/`export`.
- **Name-collision policy: suffix `-2`, `-3`, …** for both the panel name and any colliding expert slugs. Promotion is non-destructive: it never overwrites or silently reuses an existing library panel/expert. Renames are surfaced in the command output ("Note: … already existed; saved as …").
**Alternatives considered**:
- **A dedicated `panel_definition` table / DB migration** — rejected: migrations are HUMAN-REQUIRED in this repo, and `config_json` already carries per-session config. JSON-in-column is backward-compatible and reversible.
- **Auto-save every auto-composed panel to the library** — rejected: pollutes the library with one entry per convene run; promotion should be a deliberate, opt-in act. The convene banner + tip now point users at `panel save` instead.
- **Error on name/slug collision** — rejected as the default: forces the user to re-run with a different name and makes promotion fail late (after some experts may exist). Suffixing always succeeds and is easy to rename later. (Considered an `--overwrite` flag; deferred — destructive and unnecessary for the core flow.)
- **Overwrite existing artifacts** — rejected: silently clobbering a hand-authored library panel/expert is data loss.
**Consequences**:
- ✅ A convened panel can be kept with one command; afterwards `council panels` lists it and `council chat <name>` resolves it (via `loadPanel`).
- ✅ Backward compatible: sessions created before this feature simply lack the `definition` key; `panel save` reports a clear `CliUserError` ("no stored panel definition … predates this feature") rather than crashing.
- ✅ DRY: `panel create` and `panel save` share one persistence path, so both produce identical, valid library panels (same rollback semantics).
- ⚠️ Repeated saves of the same session accumulate suffixed copies (`mypanel-2`, `mypanel-3`, …) rather than updating in place. Acceptable for an opt-in promote action; an explicit update/overwrite mode can be added later if needed.
- ⚠️ Suffixing can in theory exceed the 64-char slug limit for very long base slugs; not handled specially (composed slugs are short). Revisit if it surfaces.



### ADR-019: Custom in-process TypeScript extractors, not Microsoft MarkItDown
**Date**: 2026-06-14
**Status**: Accepted
**Context**: The document-extraction feature expanded support from 3 text formats (`.md`, `.txt`, `.html`) to 13+ binary/structured formats (PDF, DOCX, PPTX, XLSX, CSV/TSV, RTF, ODT/ODS/ODP). This raised a natural build-vs-buy question: why not adopt Microsoft's [MarkItDown](https://github.com/microsoft/markitdown), a popular, well-maintained file→Markdown converter that already covers PDF/DOCX/PPTX/XLSX/HTML/CSV and more? The choice to build was never recorded, so the question keeps resurfacing.
**Decision**: Implement a custom in-process extractor registry in TypeScript (`src/core/documents/extractors/`) built on npm-native libraries (`pdfjs-dist`, `mammoth`, `exceljs`, `yauzl`, `fast-xml-parser`). Do not depend on MarkItDown. This fulfills the path ADR-009 explicitly forecast — real parsers landing in new, format-dispatched modules rather than replacing the regex text normalisers.
**Alternatives considered**:
- **MarkItDown via subprocess** — MarkItDown is a Python 3.10+ package with no Node binding. Shelling out forces every end user to install Python + `pip install markitdown[all]`, which breaks Council's "just works" npm-global UX — the exact problem this feature set out to fix. Bundling a Python runtime (tens of MB, per-OS packaging, code signing) or running a sidecar service is disproportionate for an offline single-user CLI.
- **MarkItDown as a hosted/sidecar service** — adds a network/process dependency and deployment surface unjustified for local use.
- **`textract` / other Node libraries** — none match the per-format coverage assembled here, and most are unmaintained.
**Consequences**:
- ✅ Zero extra runtime: `npm i -g council` still works with no toolchain; extractors lazy-load per format (factory thunks resolved on first use), so CLI startup cost stays zero.
- ✅ We own the security boundary. MarkItDown explicitly delegates input safety to the caller ("Do not pass untrusted input directly… it must be validated and restricted before calling") and its `convert()` will fetch remote URIs (an SSRF surface). Council's threat model is "untrusted file dropped by a user," so we built a TOCTOU-safe read boundary, ZIP-bomb preflight, ReDoS-bounded XML scanning, magic-byte blocklists, filename sanitization, and prompt-injection delimiters (ADR-012) — hardening we would have needed as a MarkItDown wrapper regardless.
- ⚠️ Narrower format breadth: MarkItDown also handles image OCR, audio transcription, EPub, and YouTube. We deliberately skip these. If demand arises, revisit MarkItDown or Azure Document Intelligence as an **optional, user-opted** enhancement to the AI-fallback path — never a hard dependency.
- ⚠️ We maintain per-parser hardening ourselves; new format bugs are ours to fix (tracked via `sentinel:*` issues).

### ADR-018: ASCII Symbol System
**Date**: 2026-05-22
**Status**: Accepted
**Context**: Unicode symbols (🏛️ ━ ─ ✅ ❌ ▋) fail on legacy terminals (Windows cmd.exe, ConPTY in some configurations) and screen readers that announce emoji descriptions verbosely. Users in CI environments and piped contexts also encounter garbled output.
**Decision**: `src/cli/renderers/symbols.ts` exports `getSymbols()` returning a Unicode or ASCII symbol set based on environment auto-detection. Detection triggers: `NO_COLOR` env var set, `TERM=dumb`, or `COUNCIL_ASCII=1`. All renderers (Ink, Plain, Chat) consume symbols exclusively through this registry.
**Alternatives considered**:
- **Always ASCII** — simplest but too plain for modern terminals; sacrifices visual quality for the majority.
- **Detection library (`is-unicode-supported`)** — adds a dependency for something achievable with 3 env-var checks.
- **User config only (`config.yaml` toggle)** — not auto-detected; fails for CI and screen readers unless manually configured.
**Consequences**:
- ✅ Zero new dependencies. Three env-var checks cover all known failure modes.
- ✅ Screen readers get clean text instead of verbose emoji descriptions.
- ✅ CI/pipe output is predictable and parseable.
- ⚠️ Auto-detection may false-positive on exotic terminals that support Unicode but set `TERM=dumb` for other reasons. Explicit `COUNCIL_ASCII=1` overrides auto-detection for intentional ASCII use.

### ADR-017: Engine Default & First-Run UX
**Date**: 2026-05-21
**Status**: Accepted
**Context**: `--engine copilot` was required on every command that invokes the AI. 99% of users want copilot (the mock engine is for testing). Requiring the flag on every invocation adds friction and clutters examples.
**Decision**: Default engine is `copilot`, read from config. First-run detection (no `~/.council/config.yaml` exists) auto-creates a default config file so subsequent commands work without manual setup. `council doctor` validates the environment and provides guidance.
**Alternatives considered**:
- **Hard-code `copilot` with no config** — prevents mock from being the default in test environments without passing `--engine mock` every time.
- **Environment variable only (`COUNCIL_ENGINE`)** — less discoverable than config; doesn't solve first-run UX.
- **Interactive setup wizard** — too heavy for a CLI tool; `council doctor` already validates the environment.
**Consequences**:
- ✅ Every example and common invocation drops `--engine copilot` — shorter, cleaner.
- ✅ First-run users get a valid config automatically; `council doctor` provides guidance.
- ✅ Test scripts can set `defaults.engine: mock` in config or pass `--engine mock` explicitly.
- ⚠️ Breaking: scripts that relied on "no default" behavior to force explicit engine choice will now silently use copilot. Mitigated by the `--continue` → `--prompt` rename being the louder breaking change in the same release.

### ADR-016: Unified Expert Color Palette
**Date**: 2026-05-20
**Status**: Accepted
**Context**: The Ink renderer used 6 colors, the Chat renderer used 8, and the Plain renderer used a single uniform cyan. Red was in the expert palette, colliding visually with error messages. Color-blind users had no redundant cue to distinguish speakers.
**Decision**: A shared 8-color palette (`cyan`, `yellow`, `magenta`, `green`, `blue`, `cyanBright`, `magentaBright`, `yellowBright`) lives in `src/cli/renderers/ink/colors.ts` and is consumed by all three renderers. Red is excluded to avoid error-message collision. Every renderer additionally prefixes expert names with `[N]` index numbers for color-blind redundancy.
**Alternatives considered**:
- **Role-based colors** (CTO always blue, PM always green) — too rigid; custom panels have arbitrary expert roles.
- **Shape-only differentiation** (no color, just prefixes) — not enough visual distinction for panels with 4+ experts; discards a useful visual channel.
- **Per-renderer independent palettes** — the status quo; inconsistent experience when switching between `--format plain` and TTY output.
**Consequences**:
- ✅ Consistent visual identity for experts across all output modes.
- ✅ Color-blind users can distinguish speakers via `[N]` index alone.
- ✅ Red is reserved for errors system-wide — no confusion between expert speech and error messages.
- ⚠️ 8-color palette wraps for panels with 9+ experts (repeats from the beginning). Acceptable: most panels have 3–5 experts.

### ADR-015: Semantic Exit Codes
**Date**: 2026-05-19
**Status**: Accepted
**Context**: `handleCliError` returned exit code 1 for all errors. CI pipelines and scripts could not distinguish between "user passed bad flags" (fix your script), "auth expired" (re-login), "network timeout" (retry), and "internal bug" (file an issue). All were opaque failures requiring log inspection.
**Decision**: Exit codes 0–4 mapped from `EngineErrorCode`: `0`=success, `1`=user/validation error, `2`=authentication failure, `3`=network/transient (retriable), `4`=internal/unexpected. Constants live in `src/cli/exit-codes.ts`. The mapping is applied in the top-level error handler.
**Alternatives considered**:
- **Single exit code (status quo)** — simplest but useless for automation.
- **HTTP-style codes (200, 401, 500, etc.)** — familiar but non-standard for CLI tools; shells truncate to 0–255 and some reserve ranges (e.g., 126–128 for exec/signal).
- **Signal-based differentiation** — non-portable across Windows/Unix; confuses "killed by signal" with "error type".
**Consequences**:
- ✅ CI scripts can `case $?` to decide retry vs. fail-fast vs. re-auth without parsing stderr.
- ✅ Aligns with common CLI conventions (curl uses similar ranges; git uses 128 for fatal).
- ✅ Small, stable set — adding a 5th code is future-safe without breaking existing consumers.
- ⚠️ Existing scripts that check `!= 0` as "any failure" are unaffected; only scripts that switch on specific codes benefit.

### ADR-014: Versioning strategy — Release Please with conventional commits
**Date**: 2026-05-17
**Status**: Accepted
**Context**: The project declared semver intent in CHANGELOG.md and had `"version": "0.1.0"` in package.json, but no release tooling, version tags, or documented release process existed. A versioning system was needed to automate changelog generation, version bumping, and GitHub releases.
**Decision**: Adopt [Release Please](https://github.com/googleapis/release-please) as the automated versioning tool. It reads conventional commits (already enforced by AGENTS.md commit format) to determine semver bumps and maintains a "Release PR" that accumulates changes. Merging the Release PR tags the release, bumps package.json, updates CHANGELOG.md, and creates a GitHub Release. Configuration: `bump-minor-pre-major: true` (breaking changes bump minor at 0.x), `bump-patch-for-minor-pre-major: false` (features bump minor as normal). Only `feat`, `fix`, `perf`, and `revert` commits appear in the changelog; `docs`, `chore`, `ci`, `test`, `refactor`, `style`, `build`, and `deps` are hidden.
**Alternatives considered**:
- **Changesets (`@changesets/cli`)** — requires developers to create a changeset file per PR describing the bump type. More manual control but adds friction. Council already enforces conventional commits, making this redundant.
- **Manual versioning** — error-prone, inconsistent, and no automation. Doesn't scale.
- **Semantic Release** — fully automated (publishes immediately on merge). Too aggressive for a pre-1.0 CLI tool where release timing should be deliberate.
**Consequences**:
- ✅ Zero workflow changes — leverages existing conventional commit enforcement
- ✅ Deliberate releases — the Release PR accumulates changes; you merge when ready to ship
- ✅ Automated changelog, version bumps, git tags, and GitHub Releases
- ⚠️ Requires `GITHUB_TOKEN` with write permissions (default token works but CI won't trigger on release PRs — upgrade to PAT if needed)
- ⚠️ `bootstrap-sha` set to current HEAD; commits before this SHA are excluded from the first release changelog

### ADR-013: Test execution policy — categorised scripts and CI pipeline
**Date**: 2026-05-16
**Status**: Accepted
**Context**: All tests ran under a single `pnpm test` command with no way to run categories independently. There was no CI workflow file. The testing strategy doc did not specify *when* each test type should run.
**Decision**: Add category-specific scripts (`test:unit`, `test:e2e`, `test:integration`, `test:security`) to `package.json`. Create a GitHub Actions CI workflow (`.github/workflows/ci.yml`) that runs typecheck → lint → unit → e2e → security on every PR and push to `main`. Integration tests remain manual-only (`COUNCIL_INTEGRATION=1`). Smoke tests remain a manual pre-release checklist. Keep `pnpm test` as the full-suite command for local development.
**Alternatives considered**:
- **Vitest workspace/projects** — would allow parallel runs and separate configs per category, but adds configuration complexity for no practical gain since the full suite runs in under 2 minutes.
- **Separate CI jobs per category** — would allow parallel execution, but adds matrix complexity and the current suite is fast enough that sequential steps are simpler and cheaper.
- **Include integration tests in CI** — rejected because they require a real Copilot SDK session, consume premium tokens, and need authenticated `gh` credentials in the runner.
**Consequences**:
- ✅ Developers and CI can run specific test categories independently
- ✅ CI catches regressions before Sentinel review begins
- ✅ Integration and smoke tests stay manual, avoiding token costs and auth complexity in CI
- ⚠️ Integration tests have no automated CI safety net — regressions caught only during manual pre-release testing

### ADR-012: Layered prompt injection defense (zero external dependencies)
**Date**: 2026-05-14
**Status**: Accepted
**Context**: Council's multi-agent architecture creates an unusually wide prompt-injection surface compared to a single-agent chat tool. Cross-expert turns, LLM-composed panel definitions, persisted rolling summaries, RAG document snippets, persona profiles distilled from user-supplied documents, and `extracted_memory_json` rows all carry untrusted text that ends up interpolated into a privileged system prompt for the *next* expert. A successful injection in one expert's output can therefore propagate to another expert in the same panel, to a future chat turn (via summary or memory), or to a different panel altogether (via the cross-panel-awareness `[PANEL MEMBERSHIPS]` section). The defense must be present at every untrusted-data surface, must not rely on a single sanitiser working perfectly, and — critically for a zero-setup CLI — must not require a network API key, an ONNX runtime, or a 100MB+ classifier download to be functional out of the box.

**Decision**: Adopt a **5-layer in-process defense** with **zero new dependencies**:
1. **Structural sanitisation** — `sanitizePromptField` / `sanitizePromptBlock` / `sanitizeFenced` / `escapeFenceContent` in `src/core/prompt-sanitize.ts`. NFKC-normalises the input first so compatibility/fullwidth forms (e.g. `Ａ` → `A`, `［１］` → `[1]`) cannot bypass downstream pattern matching, then strips C0 controls (except `\t`/`\n`/`\r`) and DEL, strips bidi/zero-width characters, collapses Unicode line separators (NEL / U+2028 / U+2029), defangs `[N]` section markers, caps length. (C1 controls U+0080–U+009F are stripped separately by the chat renderer where terminal-side reinterpretation is the threat.) Field variant collapses newlines (for system-prompt fields); block variant preserves them (for fenced bodies).
2. **Heuristic detection** — `detectInstructionPatterns` in the same module returns matched suspicious-pattern names for telemetry/canary-triage. Does not hard-block (false-positive cost too high).
3. **Fencing & spotlighting** — untrusted content is wrapped in XML-style fences (`<from_expert>`, `<summary>`, `<transcript>`, `[REFERENCE DOCUMENT]`) with paired preambles instructing the model to treat fenced regions as evidence, not instructions. Fence attributes are escaped against both tag-break (`<`) and attribute-break (`"`).
4. **Schema enforcement** — `ExpertDefinitionSchema`'s Zod `superRefine` rejects `[NN]` section markers in string fields at parse time, so malicious YAML cannot even load.
5. **Canary tokens** — `src/core/canary.ts` injects a random opaque token into the system prompt and scans every expert response. A leak is a strong prompt-injection signal surfaced to the user as a warning.

All five layers are sync, in-process, and execute in under 1ms per call.

**Alternatives considered**:
- **External ML classifier (Lakera Guard, hosted)** — high-quality detection, but requires a network round-trip per turn, an API key in every user's install, and shipping every expert turn to a third party. Conflicts with the zero-setup CLI promise and the privacy posture of a local-first tool.
- **Local ONNX classifier (Microsoft Prompt Guard 2)** — no network, but adds ~100MB of model weights, an `onnxruntime` native dependency (re-introduces the `better-sqlite3`-style prebuild risk that ADR-005 was specifically designed to avoid), and ~50–200ms inference latency per check. Out of proportion to the threat model for a CLI deliberation tool.
- **Heuristic regex blocking only (no sanitisation, no fencing)** — trivial to bypass with Unicode homoglyphs, zero-width spaces, or split tokens. Single-layer defenses are by definition not defense-in-depth.
- **Trust the LLM to ignore injection attempts** — modern instruction-tuned models are partially robust, but the academic and red-team literature (Greshake et al.; Willison's prompt-injection series; the OWASP LLM Top 10) is unambiguous that this is not a defense.

External ML classifiers are **deferred to Phase 4** as an optional layer if the heuristic and canary signals prove insufficient in practice. The architectural seam to add one is straightforward: a single `IPromptInspector` interface in front of the heuristic detector.

**Consequences**:
- ✅ Zero new dependencies. No API key, no ONNX runtime, no model download — the defense works on `npm install -g` with nothing else configured.
- ✅ All defense is sync and sub-millisecond. No per-turn latency budget consumed by injection screening.
- ✅ Local-first / privacy posture preserved — no expert content is shipped to a third party for screening.
- ✅ Layered: a bypass of one layer (e.g. a novel Unicode sequence that survives sanitisation) is still caught by fencing, schema rejection, or canary detection.
- ⚠️ No ML-based semantic classification. Sophisticated obfuscated attacks that survive heuristic detection will only be caught at fence/canary boundaries, not pre-flagged.
- ⚠️ Heuristic and canary detection are *signals*, not blocks — surfaced as warnings, not enforced rejections. Adding a hard-block mode is a future decision tied to deployment context (CI vs. interactive).
- 📝 Test coverage in `tests/security/` (30 deterministic red-team payloads) is the ratchet — coverage of injection categories must not decrease, and new bypasses discovered in the wild land as new hardcoded tests cited by issue/PR.
- 📝 When adding a new untrusted-data surface (new RAG source, new cross-expert relay, new LLM-distilled field), the author MUST identify which of the five layers apply and wire them in before the surface ships. Sentinel verifies this on the introducing PR.

### ADR-011: User data directory split— `~/Council/` (visible) vs `~/.council/` (hidden)
**Date**: 2026-05-12
**Status**: Accepted
**Context**: Council writes two very different kinds of state to the user's home directory: (a) **author-facing artifacts** — expert YAMLs, panel YAMLs, persona document folders that users are expected to open in an editor, drag documents into, and version-control if they choose; and (b) **internal state** — the libsql database file, the resolved config, FTS indexes, generated profiles. Putting both in a single hidden `~/.council/` (the "Unix dotfile" default) hides the author-facing files from normal file-browser navigation, drag-and-drop, and `~/Documents`-style discovery; putting both in a visible `~/Council/` clutters the user's home with internal binaries (`council.db`, FTS shadow files) that they should not be editing.

**Decision**: Split user data across two directories on a single rule — **author-facing → visible, machine-managed → hidden**:
- `~/Council/` (visible, capitalised like `~/Documents`) holds expert YAMLs (`experts/<slug>.yaml`), panel YAMLs (`panels/<name>.yaml`), persona document folders (`experts/<slug>/docs/`), and panel document folders (`panels/<name>/docs/`). Resolved via `getCouncilDataHome(config?)` in `src/config/loader.ts`, which honours the `COUNCIL_DATA_HOME` env var (and the `paths.dataHome` config key) for tests and ephemeral mode. Users can open, edit, version-control, and drag files in/out freely; the document scanners detect changes via SHA-256 on the next `council chat`.
- `~/.council/` (hidden) holds `config.yaml` and `council.db` (and any future FTS shadow files / lock files / caches). Resolved via `getCouncilHome()` in `src/config/loader.ts`, which honours `COUNCIL_HOME`. Users have no business editing these directly.

The two env vars (`COUNCIL_HOME` and `COUNCIL_DATA_HOME`) are independent so tests can isolate the hidden state, the visible library, or both.

**Alternatives considered**:
- **Single `~/.council/` for everything.** Familiar Unix convention, single env var, but defeats the entire premise of "drop documents in to teach an expert" — users cannot see the docs folder in Finder/Explorer without enabling hidden files, and drag-and-drop is awkward.
- **Single `~/Council/` for everything.** Discoverable, but pollutes the user's home with `council.db` and internal state they shouldn't touch; risks accidental deletion of the DB while "cleaning up".
- **`~/Documents/Council/` for visible, `~/.config/council/` for hidden** (XDG-style). Closer to convention on Linux, but `~/Documents/` paths are localised on Windows and macOS (e.g. `~/Documenti/`), and `~/.config/` is non-idiomatic on Windows. Capitalised `~/Council/` is short, cross-platform, and matches the brand.

**Consequences**:
- ✅ Users can teach a persona expert by dragging documents into a folder they can actually find.
- ✅ Internal state stays out of the way; accidental `rm -rf ~/Council/` does not destroy the DB or config.
- ✅ Backup/version-control story is clear: `~/Council/` is safe to commit (or to `rsync` to another machine); `~/.council/` is not portable (libsql DB, schema-versioned).
- ⚠️ Two roots is one more concept than one root. Mitigated by: every CLI command resolves both paths via the same helpers (`getCouncilHome()` / `getCouncilDataHome()`), and `council doctor` prints both paths so users can find them.
- 📝 If a third category emerges (e.g. exported transcripts, telemetry) it lands under whichever root matches the same rule — author-facing → visible, machine-managed → hidden.

### ADR-010: Chat session model — separate `chat_sessions` / `chat_turns` tables, atomic seq allocation
**Date**: 2026-05-11
**Status**: Accepted
**Context**: Roadmap 5.x introduces persistent conversational chat (`council chat <expert>` and `council chat <panel>`) alongside the existing structured-debate machinery. Chat and debate share superficial structure (a sequence of speaker turns), so the obvious move is to reuse `debates` + `turns` with a new `kind` discriminator. On closer inspection the lifecycles diverge sharply: a debate is **bounded** (one prompt, fixed phases, terminal `status`, cost-estimated up front, persisted moderator strategy), while a chat is **open-ended and resumable** (no terminal phase, indefinite turn count, archive-don't-delete semantics, no moderator). Reusing `debates`/`turns` would force every column to be nullable for the side it doesn't apply to, dilute the meaning of `status`, and complicate the queries that already drive `council resume` / `council export`. A separate concern: every per-turn write needs a monotonic `seq` per session for replay ordering, and the chat REPL is the first code path where two turns can race (user types ahead while the engine is still streaming).

**Decision**:
- **Two new tables** in migration 005:
  - `chat_sessions` — `{ id (ULID), target_type ('expert'|'panel'), target_slug, status ('active'|'archived'), summary, summary_through_seq, created_at, updated_at }`. The "one active session per target" invariant is enforced at the application layer (`ChatRepository.findActiveSession` plus `archiveSession` before `createSession` in the chat command), not by a DB constraint, so the migration stays portable across libsql / Turso without partial-index syntax differences.
  - `chat_turns` — `{ id (ULID), chat_id (FK CASCADE), seq, role ('user'|'expert'), expert_slug (NULL for user turns), content, is_mention, tokens_in, tokens_out, created_at }` with `UNIQUE (chat_id, seq)` (declared in `005_chat.sql`) plus `idx_chat_turns_chat_seq` for ordered reads.
- **Atomic seq allocation** via `INSERT … SELECT COALESCE(MAX(seq), 0) + 1 …` in `ChatRepository.addTurn` so the read-and-increment happens in a single statement: no application-side race window even when a future caller concurrently appends to the same chat.
- **No reuse of `debates` / `turns`.** The structured-debate tables stay focused on bounded debates with phases, moderators, and cost ceilings.

**Alternatives considered**:
- **Reuse `debates` + `turns` with a `kind` column.** Smallest schema delta, but every chat-irrelevant column (`moderator`, `mode`, `cost_estimate`, terminal `status`) becomes nullable-and-meaningless for chat rows, and every debate query has to filter `WHERE kind = 'debate'`. The conceptual saving evaporates almost immediately.
- **App-side seq allocation (`SELECT MAX(seq) + 1` then `INSERT`).** Two statements, racy under concurrent appends — exactly the bug the single-statement form prevents. No retry loop needed because the seq is computed and inserted atomically.
- **Auto-increment `seq` via a trigger.** Works, but pushes write logic into SQL the JS code can't easily reason about, and the `INSERT … SELECT` form is portable across libsql/Turso without custom trigger setup.
- **Partial unique index on `(target_type, target_slug) WHERE status='active'`.** Would push the "one active session per target" rule into the schema, but libsql partial-index support is uneven and the application-layer guard is straightforward; deferred unless concurrent session creation becomes a real failure mode.

**Consequences**:
- ✅ Chat and debate evolve independently; adding a column for one cannot accidentally affect the other.
- ✅ `ChatRepository.addTurn` is a single round-trip with no app-side race window.
- ✅ Archive semantics are first-class: `council chat <target> --new` flips `status='archived'` on the active session and inserts a fresh one without touching turn history.
- ⚠️ The "one active session per target" invariant lives in application code, not the schema; a future caller bypassing the chat command could create a duplicate active row. Mitigated by a single chokepoint (`runExpertChat` / `runPanelChat`) and a follow-up issue if a second writer ever materialises.
- ⚠️ Two near-isomorphic table pairs (`debates`/`turns` and `chat_sessions`/`chat_turns`) — same trade-off as panel vs expert documents (ADR-007). Tolerated because the parent semantics differ.
- 📝 If a future feature needs to query "all turns for an expert across debates AND chats" it will need a UNION view; acceptable, that view does not exist yet.

### ADR-009: Regex-based document normalisation, not a Markdown/HTML parser
**Date**: 2026-05-10
**Status**: Accepted
**Context**: Roadmap 6.1 needs to extract plain text from `.md`, `.html`, and `.txt` documents to feed both FTS5 indexing and the persona-profile analyzer. The natural reach is a real parser per format (`marked` / `remark` for Markdown, `parse5` / `cheerio` for HTML). Council's actual need is far narrower: strip formatting and emit a normalised body suitable for tokenisation. The extractor is on the `council chat` startup hot path and must work in offline / air-gapped environments where heavy parser dependencies hurt install size and audit surface.

**Decision**: `src/core/documents/extractor.ts` uses a small set of hand-written regex normalisers per format (HTML entity decoding, tag stripping, Markdown punctuation removal, whitespace collapse). The JSDoc explicitly states "intentionally simple (regex-based); strips formatting but does not aim to be a full parser." Parser correctness is not promised; FTS5 robustness against imperfect tokenisation is.

**Alternatives considered**:
- **`marked` + `cheerio`** — production-grade output but adds ~400KB of runtime deps (transitive `entities`, `parse5`), expands the security audit surface, and pulls dependencies into a code path that already stays close to `node:fs`. Rejected as gold-plating for an FTS pre-processor.
- **`@mozilla/readability` / `jsdom`** — designed for article extraction, not arbitrary user docs; too opinionated and pulls in ~3MB of DOM emulation.
- **No normalisation (raw bytes → FTS)** — FTS5's tokeniser already handles punctuation, but Markdown link syntax (`[text](url)`) and HTML tags would inflate the index with noise tokens, and the persona-profile analyzer would receive markup soup.

**Consequences**:
- ✅ Zero runtime dependencies for extraction; install size unchanged.
- ✅ Fast, predictable, offline-safe — the extractor never touches the network or spawns subprocesses.
- ✅ Easy to audit: ~100 lines of regex with explicit test coverage per format.
- ⚠️ Pathological inputs (deeply-nested HTML, custom Markdown extensions) may produce imperfect text. Acceptable: FTS5 ranking absorbs noise, and the persona analyzer treats every fenced document as untrusted data anyway.
- 📝 If a real parser is ever needed (e.g. `.docx` / `.pdf` in Phase 8), it lands in a NEW module behind a format-dispatched interface — not by replacing the regex normalisers wholesale.

### ADR-008: Persona profile analysis — LLM extraction with single-retry, multi-layer sanitisation
**Date**: 2026-05-09
**Status**: Accepted
**Context**: Roadmap 6.2 turns persona-expert documents (CVs, design docs, RFCs, prior emails) into a structured behavioural profile that the prompt-builder injects as `[N] PERSONA PROFILE`. The mechanics had three open questions: (1) heuristic vs LLM extraction, (2) how to budget retries when the LLM returns malformed JSON, and (3) how to defend a privileged system prompt against injection through user-controlled file content.

**Decision**:
1. **LLM extraction via a transient "Profile Analyzer" expert.** Register, send a meta-prompt with fenced document blocks + any `existingProfile` to update, parse the JSON response into `PersonaProfile`. Tear the analyzer down in a `finally` block (engine-cleanup failures surface as warnings, never mask the analysis result).
2. **One retry on malformed JSON.** A single retry absorbs transient streaming truncation; persistent malformedness throws `Error("Profile analyzer returned unparsable JSON after retry")`. No exponential back-off, no second retry — the cost ceiling is two LLM calls per persona refresh. "Malformed" is permissive: a leading ```` ```json ```` / ```` ``` ```` code fence is stripped, then `JSON.parse` runs; the result is treated as malformed only if the parse throws OR `communicationStyle` / `epistemicStance` are missing or empty (the two narrative fields the profile cannot do without). Other fields are coerced (non-string entries dropped from arrays; non-strings become `""`) rather than triggering a retry.
3. **Defense-in-depth sanitisation:**
   - System prompt explicitly marks document content as untrusted data.
   - Document bodies are wrapped in `<documents>` fences; every `<` in interpolated content is escaped to `&lt;` so an XML-like tag cannot close the fence prematurely.
   - `existingProfile` fields are run through `sanitizePromptField` (`src/core/prompt-sanitize.ts`) — C0 controls stripped, Unicode line breaks (NEL / U+2028 / U+2029) and CR/LF runs collapsed, bracketed `[N]` section markers defanged to `(sec-N)`, length capped at 2000 chars — BEFORE the per-character `<` escape is applied, layering field-level and fence-level defenses.

**Alternatives considered**:
- **Heuristic extraction (n-gram frequencies, regex stance phrases).** Cheap and offline, but cannot capture nuanced behavioural patterns or update an existing profile coherently. Kept as a fallback elsewhere (`recallMemory`); not appropriate for persona profiles.
- **Multi-retry with exponential backoff.** Out of proportion for a JSON-parse failure mode; wastes premium-request budget on a structural problem the model is unlikely to fix on its own.
- **Single-pass sanitisation (just the `<` escape, or just `sanitizePromptField`).** Either layer alone has known bypasses (e.g. raw newlines surviving the `<` escape; `<` payloads surviving `sanitizePromptField`'s defang-but-don't-escape rule). Stacking is the cheap, robust answer.

**Consequences**:
- ✅ Profile quality is meaningfully better than heuristics — the LLM can synthesise `epistemicStance` and `decisionPatterns` from prose.
- ✅ Bounded cost: at most 2 LLM calls per `council chat <persona>` invocation that detected document changes.
- ✅ Hardened against fence-break, `[N]`-marker spoofing, runaway-length fields, and C0 / Unicode-line-break payloads (regression tests live in `tests/unit/core/documents/profile-analyzer.test.ts`, with the dedicated sanitization assertions starting around the `escapes fence-breaking characters in the existing-profile block` case).
- ⚠️ Still depends on the engine respecting the "treat fenced content as data" instruction. Mitigated by the field-level + fence-level escape layers, but not absolutely guaranteed for all future models.
- 📝 The transient-analyzer cleanup pattern is reusable: see `src/core/auto-compose.ts` for the original instance.

### ADR-007: `panel_documents` schema mirrors `expert_documents`, with `source` discriminator
**Date**: 2026-05-09
**Status**: Accepted
**Context**: Roadmap 6.7 (Panel Document Folder) adds a panel-shared RAG corpus that participates in the same FTS5 `document_index` as expert docs. The corpus has two provenance kinds: a managed folder auto-provisioned at `~/Council/panels/<name>/docs/` and an arbitrary number of user-linked external folders. Panels are addressed by `name` (string PK), not by ULID like experts. Two design questions: (1) one table or two for managed vs linked? (2) reuse the `expert_documents` shape verbatim, or design fresh?

**Decision**: Migration 009 creates two tables:
- **`panel_linked_folders`** — small registry of external folders per panel (`{ id (ULID), panel_name (FK CASCADE), folder_path, created_at }` with `UNIQUE (panel_name, folder_path)`).
- **`panel_documents`** — file tracking, intentionally near-isomorphic to `expert_documents`: `{ id (ULID), panel_name (FK CASCADE → panel_library.name), source ('managed' | 'linked'), file_path, filename, checksum, size_bytes, word_count, status, processed_at, created_at }` with `UNIQUE (panel_name, file_path)` and `idx_panel_documents_panel (panel_name, status)`.

Provenance is a column on the per-file row, not a separate table. FTS index entries differentiate panel docs from expert docs via `source_type='panel'` (already in migration 007).

**Alternatives considered**:
- **Single unified `documents` table for experts + panels.** Forces every row to carry both an `expert_slug` and a `panel_name` (one always NULL), complicating FK constraints (CASCADE on different parents) and indexing. The shapes are identical but the parent semantics aren't.
- **Separate `panel_managed_documents` and `panel_linked_documents` tables.** Doubles the surface for queries that don't care about provenance ("how many docs does this panel have?") and makes the scanner query the same row shape twice.
- **Store linked folders in a JSON column on `panel_library`.** Fast to write, but precludes `ON DELETE CASCADE`, breaks per-folder indexing, and forces the scanner to round-trip through application-level JSON parsing for every read.

**Consequences**:
- ✅ The expert and panel scanners share the same `DocumentDetectionResult` shape and the same FTS5 indexer, with provenance plumbed through as opaque metadata.
- ✅ `ON DELETE CASCADE` on both tables means `panel delete <name>` cleans up linked-folder registrations and per-file rows automatically; the FTS index is purged separately by the unlink/delete handlers.
- ✅ The `source` discriminator lets the scanner enforce the rule that **only the managed folder is auto-provisioned** while linked folders require an explicit `council panel docs link` (with up-front symlink rejection).
- ⚠️ Two near-isomorphic tables (`expert_documents` and `panel_documents`) duplicate column definitions. Tolerated; consolidation would couple two independent migration tracks.

### ADR-006: `migrateBuiltInTemplates` takes both `library` and `db` explicitly
**Date**: 2026-05-08
**Status**: Accepted
**Context**: Roadmap 4.6 needed a one-shot migration of the built-in panel templates' inline experts into the new library format (`~/Council/experts/<slug>.yaml` + an `expert_library` SQLite row) plus a rewrite of each panel into `~/Council/panels/<name>.yaml` with slug references (rows in `panel_library` + `panel_members`). The `ExpertLibrary` interface (`src/core/expert-library.ts`) intentionally abstracts the storage backend for experts only; it does NOT expose the `panel_library` / `panel_members` tables. The first implementation reached for the DB by `(library as FileExpertLibrary).getDb()`, an unsafe cast that hid the dependency from the type system and broke for any non-file backend.

**Decision**: `migrateBuiltInTemplates(dataHome, library, db, options?)` accepts the `CouncilDatabase` handle as an explicit parameter alongside the library. The migration writes expert YAMLs (and library rows) through `library`/`ExpertLibraryRepository`, and panel rows through `db` directly. `isMigrationNeeded(dataHome, db?)` also accepts the DB optionally, returning true when either the experts directory is empty OR the `expert_library` table is empty OR the `panel_library` table is empty — so a DB reset that lost either side of the registry (with YAMLs still on disk) triggers a re-register pass that refreshes stale `panel_library` metadata from the user-edited panel YAML and materialises inline expert overrides into `expert_library`.

**Alternatives considered**:
- **Add `panel_library` / `panel_members` methods to the `ExpertLibrary` interface.** Rejected: panel storage is conceptually separate from expert storage, and a generic library backend (e.g. a future remote/Cloud library) might not own panel state at all. Polluting the interface would force every backend to implement panel methods it doesn't need.
- **Introduce a `PanelLibrary` interface and pass that instead.** Worth doing eventually but premature for a single caller (the migration). Deferred until a second consumer materialises.
- **Keep the `getDb()` cast but make it an explicit method on `ExpertLibrary`.** Same downsides as the first alternative, plus it leaks a libsql-specific handle through the abstraction.

**Consequences**:
- ✅ Type-safe: no `any` cast, no narrowing assumption about the library implementation.
- ✅ Testable: tests pass an in-memory `CouncilDatabase` directly instead of constructing a backing `FileExpertLibrary` just to extract its DB.
- ✅ Crash-recoverable: with the DB handle available, the migration can register panel rows idempotently and re-sync from disk after a DB reset.
- ⚠️ Two parameters where one might feel cleaner. Acceptable until a `PanelLibrary` abstraction earns its keep.

### ADR-001: Use @github/copilot-sdk as primary AI engine
**Date**: 2026-05-06
**Status**: Accepted
**Context**: Council needs multi-model AI access (GPT, Claude, Gemini) for expert panels. Options were: direct provider APIs (OpenAI, Anthropic, Google separately), Vercel AI SDK (unified wrapper), or GitHub Copilot SDK.
**Decision**: Use `@github/copilot-sdk` as the primary engine, behind a `CouncilEngine` abstraction interface.
**Alternatives considered**: Vercel AI SDK (good unified interface but requires separate API keys per provider), direct provider APIs (maximum control but complex key management and billing).
**Consequences**: Zero API key setup for users with Copilot subscription. Locked to Copilot's model availability and rate limits. SDK is in public preview and may break. Mitigated by `CouncilEngine` interface that allows swapping engines. Direct provider adapters planned for Phase 8.

### ADR-002: SQLite as orchestration index, not transcript store
**Date**: 2026-05-06
**Status**: Accepted (backend choice updated by ADR-005 on 2026-05-07: now `@libsql/client`, not `better-sqlite3`; the orchestration-index-only role is unchanged)
**Context**: Need persistence for panels, experts, debates, and turn metadata. The Copilot SDK already persists session transcripts in its own `copilotHome` directory.
**Decision**: Use SQLite (better-sqlite3 + Kysely) for Council's orchestration metadata only. Do not duplicate conversation content that the SDK already stores.
**Alternatives considered**: Prisma + SQLite (too heavy for CLI, 30MB+ tax, codegen step), Drizzle ORM (viable but Kysely is lighter), full transcript duplication in SQLite.
**Consequences**: Reduces complexity ~30%. Panel/expert/debate metadata is fast to query. Full transcript retrieval requires SDK session access. Trade-off is acceptable since transcripts are needed only for display/export, not for orchestration logic.

### ADR-003: CouncilEngine interface as hard architectural seam
**Date**: 2026-05-06
**Status**: Accepted
**Context**: The Copilot SDK is in public preview and will have breaking changes. The entire product cannot be tightly coupled to a single SDK.
**Decision**: Define a `CouncilEngine` interface in `engine/index.ts`. Only `engine/copilot/adapter.ts` may import `@github/copilot-sdk`. Enforced by ESLint `no-restricted-imports` rule.
**Alternatives considered**: Direct SDK usage throughout codebase (faster to write, impossible to maintain when SDK breaks).
**Consequences**: Adding new engine backends (Anthropic direct, OpenAI direct, Ollama) becomes a weekend project. All core logic depends on Council's own domain types, not SDK types. Small overhead of maintaining the interface.

### ADR-004: denyAll permissions by default for expert sessions
**Date**: 2026-05-06
**Status**: Accepted
**Context**: The Copilot SDK's `onPermissionRequest` defaults to allow-all, granting experts filesystem, git, and web access. Experts in Council are reasoners, not autonomous agents.
**Decision**: Default permission handler is `denyAll`. Any tool access must be opt-in per expert in panel YAML config with explicit `tools:` block.
**Alternatives considered**: Allow-all with guardrails (dangerous, hard to audit), selective defaults per expert type (too complex for v0).
**Consequences**: Experts cannot accidentally delete files, push to git, or fetch URLs. Limits future "researcher expert" use cases until explicit opt-in is configured. Security-first approach is appropriate for a tool that handles potentially sensitive deliberation content.

### ADR-005: SQLite backend = `@libsql/client` (pure WASM), not `better-sqlite3`
**Date**: 2026-05-07
**Status**: Superseded by ADR-027 (was Accepted; superseded the implicit `better-sqlite3` choice in DECISIONS ADR-002 and ROADMAP §1.7)
**Context**: ROADMAP §1.7 originally specified `better-sqlite3` + Kysely. During Phase 1 implementation (after PR #54 landed) the dev environment exposed a hard blocker: `better-sqlite3@11.10.0` ships no Node 25.5.0 prebuild, and the local Visual Studio Build Tools install lacks the ClangCL toolset required by `node-gyp`. Verified runtime failure: `Could not locate the bindings file. Tried [...] compiled\25.5.0\win32\x64\better_sqlite3.node`. This blocks ROADMAP §1.7, §1.8, §1.10, §1.12, §1.13 and most of Phases 2–3. Council's positioning ("simple to run") cannot survive a tool that requires users to install Visual Studio Build Tools.

**Decision**: Use `@libsql/client` (pure JavaScript / WebAssembly, by Turso) as the SQLite backend, paired with `@libsql/kysely-libsql` as the Kysely dialect. Local file mode via `url: 'file:./db.sqlite'`; `:memory:` mode via `url: ':memory:'` for tests. No native build, no toolchain, no prebuilds.

**Alternatives considered**:
- **`node:sqlite` (built-in)** — appealing long-term but still Release Candidate in Node 24 LTS as of mid-2026; requires `--experimental-sqlite` flag; would force end users to set Node flags. Re-evaluate when stable.
- **`node-sqlite3-wasm`** — pure WASM, sync API, but smaller community and no first-party Kysely dialect (would force a custom one).
- **Stay with `better-sqlite3`** — only viable if every contributor and user installs Visual Studio Build Tools. Violates "simple to run".

**Consequences**:
- ✅ `pnpm install` works on every Node version forever, on any OS, with no toolchain prerequisites.
- ✅ Strategic alignment with Council Cloud (Phase 5): same code path moves from `file:` URL to `libsql://...` URL when we ship hosted persistence; no rewrite.
- ✅ Async API matches the rest of Council's codebase (`AsyncIterable`, `Promise`-based engine).
- ⚠️ WASM is slower than native C++ for very high query throughput. Council's workload (orchestration metadata: panels, experts, debates, turns) is well below any threshold where this matters.
- ⚠️ Some niche SQLite extensions may not be in the WASM build; revisit only if a future feature needs one.
- 📝 ROADMAP §1.7 spec updated to reference libsql syntax. AGENTS.md tech-stack line still mentions `better-sqlite3`; informational only and HUMAN REQUIRED to edit — package.json is the real source of truth.
