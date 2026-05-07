# Changelog — Council

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Project scaffolding: TypeScript ESM (Node 20+), tsup bundler, Vitest test runner, ESLint flat config v9 with typescript-eslint strict, Prettier formatter
- ESLint rule `no-restricted-imports` enforcing `@github/copilot-sdk` may only be imported from `src/engine/copilot/adapter.ts`
- CLI binary entry (`council --version`, `council --help`) using Commander.js
- Smoke test verifying Node 20+ runtime
- `src/engine/types.ts` — domain types (`ExpertSpec`, `SendOptions` with `AbortSignal`, `EngineResponse` (telemetry only — content is consumer-accumulated), `EngineError`, `EngineErrorCode`, `EngineEvent`, `ReasoningEffort`)
- `src/engine/index.ts` — `CouncilEngine` interface with documented cancellation contract (`AbortSignal`, iterator-return) and idempotency guarantees, the architectural seam between Council's domain logic and AI provider SDKs (per ADR-003)
- `src/engine/mock/mock-engine.ts` — `MockEngine` deterministic in-memory implementation of `CouncilEngine` for unit tests; covers full lifecycle (start/stop idempotency), expert registration, streaming success path, configured failures, and the cancellation contract (AbortSignal, stop(), removeExpert())
- `isRecoverable(code: EngineErrorCode): boolean` — single source of truth for retry semantics (closes issue #9). RATE_LIMITED and NETWORK are recoverable; all others are not.
- `pnpm check` script — chains `typecheck && lint && test` for a single pre-merge gate (partial fix for #13)
- `src/config/schema.ts` — Zod-based `ConfigSchema`, `CouncilConfig` type, `DEFAULT_MODEL` constant. Conservative defaults (3 experts, 4 rounds, 250-word cap)
- `src/config/loader.ts` — `loadConfig()` (reads YAML, applies defaults, writes default file when missing) and `getCouncilHome()` (honors `COUNCIL_HOME` env var for tests + ephemeral mode)
- New runtime deps: `zod`, `yaml`
- `src/core/expert.ts` — `ExpertDefinitionSchema` (Zod) for static expert profiles; validated by panel YAML loader and ad-hoc CLI definitions alike
- `src/core/prompt-builder.ts` — `buildSystemPrompt(def, memory, task)` produces the full 8-section prompt (IDENTITY → EXPERTISE PRIOR → EPISTEMIC STANCE → DEBATE PROTOCOL → OUTPUT CONTRACT → FORBIDDEN MOVES → MEMORY → CURRENT TASK). Anti-sycophancy defaults (`DEFAULT_FORBIDDEN_PHRASES`, `DEFAULT_DEBATE_PROTOCOL`, `DEFAULT_OUTPUT_CONTRACT`) are always injected; profiles may supplement but cannot remove them.
- `ExpertMemory` type — positions, updatedPriors, unresolved questions; injected as terse bulleted log into section [7]
- `src/core/template-loader.ts` — `PanelDefinitionSchema` (Zod with duplicate-slug check), `loadTemplate(name)`, `loadTemplateFromFile(path)`, `listTemplates()`
- `panels/architecture-review.yaml` — CTO, Staff Engineer, SRE Lead, Product Manager
- `panels/startup-validation.yaml` — VC Partner, Target Customer, Existing Competitor, Distribution Expert
- `panels/code-review.yaml` — Senior Developer, Security Auditor, Performance Engineer, Future Maintainer
- `panels/incident-postmortem.yaml` — SRE Lead, Engineering Manager, Customer Advocate, Blameless Facilitator
- `panels/career-coaching.yaml` — IC Mentor, Engineering Manager (was IC), VP Engineering, Career Coach
- `src/core/quality-gate.ts` — heuristic anti-sycophancy quality gate. Inspects expert responses against the 3-layer system (forbidden phrases, disagreement budget when prior speakers exist, minimum specificity) and produces a `regenerateHint` for the orchestrator to pass back on the next attempt.
- `src/engine/copilot/permissions.ts` — `denyAll` (default for all expert sessions per ADR-004) and `scopedAllow(allowed)` for opt-in per-expert tool access
- `src/engine/copilot/adapter.ts` — `CopilotEngine` implementing `CouncilEngine` over `@github/copilot-sdk`. ONLY file in the project that imports the SDK (per ESLint rule and ADR-003). Translates SDK events → `EngineEvent` stream, classifies SDK errors → `EngineError` codes, honors cancellation via `AbortSignal`/`stop()`/`removeExpert()`.
- New runtime dep: `@github/copilot-sdk@~0.3.0`
- `src/memory/db.ts` — `createDatabase(path)` returns a typed Kysely instance over libsql (pure WASM, no native build per ADR-005). Includes `splitSqlStatements` helper that respects `BEGIN/END` trigger blocks. Idempotent migration runner using a `schema_version` table.
- `src/memory/migrations/001_init.sql` — schema for panels, experts, debates, turns + FTS5 mirror table + sync triggers.
- `src/memory/repositories/{panels,experts,turns}.ts` — typed CRUD with camelCase domain objects mapped from snake_case rows. ULID-generated ids. `TurnRepository.search(query)` runs FTS5 search via raw SQL.
- New runtime deps: `@libsql/client` (^0.8.0, pinned to match `@libsql/kysely-libsql` peer), `@libsql/kysely-libsql`, `kysely`, `ulid`
- `src/core/types.ts` — `DebateEvent` discriminated union (the single event stream that flows from `Debate.run()` to renderers + persistence + cost limiter), plus `DebateEndReason` and `PanelMemberSnapshot`
- `src/core/debate.ts` — `Debate` orchestrator with freeform mode (sequential turn order within each round), translates `EngineEvent` → `DebateEvent`, emits `panel.assembled` / `round.start` / `turn.start` / `turn.delta*` / `turn.end` / `cost.update` / `round.end` / `debate.end`. Errors are non-terminal at the debate level (next expert continues).
- `src/cli/renderers/types.ts` — `Renderer` interface + `Sink` abstraction + `StreamSink` (process.stdout/stderr default).
- `src/cli/renderers/json.ts` — `JsonRenderer`: NDJSON, one JSON-encoded `DebateEvent` per line. For CI/scripts/pipes.
- `src/cli/renderers/plain.ts` — `PlainRenderer`: human-readable text with optional ANSI color (chalk forced level for predictable test output). Streams `turn.delta` immediately so users see expert responses appear as they're generated.
- New runtime dep: `chalk`
- `src/core/cost.ts` — `estimateDebateCost(input, expertCount)` returns total premium-request count + breakdown by phase. `formatCostBreakdown(estimate)` renders multi-line plain text. Used by `council convene --estimate` and the orchestrator's `cost.update` events.
- `src/cli/commands/writer.ts` — shared `Writer` injection pattern for command output (testable via parameter passing instead of Commander internals)
- `src/cli/commands/panels.ts` — `council panels [--format json|plain]` lists all panels from the local DB
- `src/cli/commands/templates.ts` — `council templates` lists built-in panel templates
- `src/cli/commands/doctor.ts` — `council doctor` runs 5 diagnostics: Node version, Council home, libsql in-memory open, Copilot SDK importable, disk-write check
- `src/bin/council.ts` — Commander program with the 3 new subcommands wired in
- `src/core/template-loader.ts` — path resolution now probes multiple candidate directories so `panels/` is found whether the code runs from `src/` or `dist/`
- **Structured debate mode (ROADMAP §2.2)** — `Debate.run()` now branches on `DebateConfig.mode`. With `mode: "structured"`, the orchestrator runs a fixed 4-phase choreography (opening → cross-examination → rebuttal → synthesis) regardless of `maxRounds`. Phase ordering is strict: phase N+1 starts only after phase N completes for every expert. Single-expert panels skip cross-exam (3 phases). Each `round.start`/`round.end` event carries an optional `phase: DebatePhase` field.
- `src/core/moderator/phase-prompts.ts` — pure phase-prompt builders: `buildOpeningPrompt`, `buildCrossExamPrompt` (returns `null` for single-expert panels), `buildRebuttalPrompt`, `buildSynthesisPrompt`. Cross-exam, rebuttal, and synthesis quote prior-turn content verbatim so deterministic structured debates work offline against MockEngine. LLM-driven moderator question generation lands in §2.3.
- `DebatePhase = "opening" | "cross-examination" | "rebuttal" | "synthesis"` exported from `src/core/types.ts`
- `MockEngine.sentPrompts` — test-only accessor capturing every prompt sent via `send()` in temporal order, for prompt-shape assertions
- **DebateRepository (`src/memory/repositories/debates.ts`)** — typed CRUD over the `debates` table. Methods: `create({ panelId, prompt, moderator })` (auto-status='running'), `findById`, `findByPanelId` (ordered by startedAt), `update({ status, endedAt, costEstimate })`. `DebateStatus = "running" | "completed" | "aborted" | "failed"`.
- **DebatePersister (`src/memory/persister.ts`)** — bridges `Debate.run()` events to the persistence layer. Wraps a `DebateEvent` stream as a passthrough: writes side effects between receive and yield. Creates a `debates` row on persist() entry, inserts one `turns` row per `turn.end` event with correct round/seq tracked from the matching `turn.start`, transitions status on `debate.end`. Skips turn.end for unmapped expert slugs (graceful). Foundational for ROADMAP §3.1 persistent-memory and §3.2 session-resume.
- **`council convene <topic> --template <name> --engine <kind>`** — runs a panel debate end-to-end. Loads template → builds 8-section system prompts → opens DB → inserts panel + experts → constructs Debate over the chosen engine → wraps in DebatePersister → renders via JSON or Plain renderer. Supports `--mode freeform|structured`, `--max-rounds`, `--max-words`, `--format json|plain`. **Engine selection is explicit (no silent default)**: `--engine mock` for offline deterministic runs (prints a prominent `[MOCK ENGINE]` warning, tags the persisted debate with `engine='mock'`); `--engine copilot` runs against the real Copilot SDK.

### Changed
- ADR-005 supersedes the implicit `better-sqlite3` choice from ADR-002 / ROADMAP §1.7. The persistence backend is now `@libsql/client` (pure WASM) + `@libsql/kysely-libsql`. Rationale: `better-sqlite3` requires native build tools and lacks Node 25.5.0 prebuilds, breaking "simple to run". libsql is pure JS, has an official Kysely dialect, and is API-compatible with Turso (Council Cloud Phase 5).
- `council convene --engine copilot` now wires the real `CopilotEngine` (previously threw "not yet wired"). Integration tests gated by `COUNCIL_INTEGRATION=1` env var (off by default for fast unit-only runs).
- `makeEngineFromKind(kind)` exported from `src/cli/commands/convene.ts` so unit tests can verify wiring without invoking the engine.

### Fixed
- `convene` MOCK warning now writes to a separate `writeError` channel (stderr), keeping `--format json` output as pure NDJSON on stdout. Resolves #127.
- `makeEngineFromKind` now has an exhaustive `default` arm that throws on unknown engine kind (previously silently returned `undefined`). Resolves #128 and #134.
- `convene` `--engine` validation now uses validate-then-assign (no silent ternary fallback). Resolves #129.
- `convene` cleanup errors (engine.stop / db.destroy) are now surfaced via `writeError` with a `!! ... failed during cleanup:` prefix instead of being silently swallowed. Resolves #130.
- `convene` registers experts in parallel via `Promise.all` instead of sequentially, cutting startup latency from O(N × session-create-ms) to O(1). Resolves #131.
- `bin/council.ts` JSDoc updated — engine is no longer "mock by default". Resolves #126.
- `makeEngineFromKind` JSDoc tagged `@internal` per stability convention. Resolves #135.
- Removed redundant `if (!INTEGRATION) describe(...)` fallback in `tests/integration/convene-copilot.test.ts`. Resolves #136.
### Removed
