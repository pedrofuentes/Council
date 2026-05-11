# Implementation Plan — Council

> Implementation-level detail for each roadmap item. For the high-level overview, see [ROADMAP.md](./ROADMAP.md).

---

## Phase 1: Foundation ✅

> **Goal**: `council convene "topic"` produces a useful multi-expert discussion in the terminal.
>
> **Status**: Complete. All 13 items shipped.

### 1.1 Project Scaffolding ✅

TypeScript ESM project (Node 20+) with tsup bundler, Vitest test runner, ESLint flat config v9 (typescript-eslint strict), and Prettier. CLI binary entry via Commander.js. Packaged as `@council/cli` with `council` binary (not yet published to npm — see Phase 4).

**Key files**: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.mjs`, `src/bin/council.ts`

### 1.2 CouncilEngine Interface ✅

Domain types (`ExpertSpec`, `SendOptions`, `EngineEvent`, `EngineError`, `EngineErrorCode`, `ReasoningEffort`) and the `CouncilEngine` interface — the architectural seam between Council's domain logic and AI provider SDKs (per ADR-003). Includes documented cancellation contract (`AbortSignal`, iterator-return) and idempotency guarantees.

**Key files**: `src/engine/index.ts`, `src/engine/types.ts`

### 1.3 MockEngine ✅

Deterministic in-memory `CouncilEngine` implementation for unit tests. Covers full lifecycle (start/stop idempotency), expert registration, streaming success path, configured failures (`failOnSend`, `failOnAddExpert`), and the cancellation contract. Includes `sentPrompts` and `removeExpertCalls` test-only accessors.

**Key files**: `src/engine/mock/mock-engine.ts`

### 1.4 Copilot SDK Adapter ✅

`CopilotEngine` implementing `CouncilEngine` over `@github/copilot-sdk`. The **only** file in the project that imports the SDK (enforced by ESLint `no-restricted-imports` rule per ADR-003). Translates SDK events → `EngineEvent` stream, classifies SDK errors → `EngineError` codes, honors cancellation via `AbortSignal`/`stop()`/`removeExpert()`. Includes `denyAll` and `scopedAllow` permission handlers (ADR-004).

**Key files**: `src/engine/copilot/adapter.ts`, `src/engine/copilot/permissions.ts`

### 1.5 Configuration System ✅

Zod-based `ConfigSchema` with conservative defaults (3 experts, 4 rounds, 250-word cap). YAML config at `~/.council/config.yaml` with auto-creation on first run. `COUNCIL_HOME` env var for test isolation.

**Key files**: `src/config/schema.ts`, `src/config/loader.ts`

### 1.6 Expert System ✅

`ExpertDefinitionSchema` (Zod) for static expert profiles. 8-section system prompt builder (IDENTITY → EXPERTISE PRIOR → EPISTEMIC STANCE → DEBATE PROTOCOL → OUTPUT CONTRACT → FORBIDDEN MOVES → MEMORY → CURRENT TASK). Anti-sycophancy defaults are always injected.

**Key files**: `src/core/expert.ts`, `src/core/prompt-builder.ts`

### 1.7 SQLite Schema ✅

`@libsql/client` (pure WASM, no native build — ADR-005) + `@libsql/kysely-libsql` dialect. Tables: `panels`, `experts`, `debates`, `turns`, `turns_fts` (FTS5), `schema_version`. Typed CRUD repositories with camelCase domain objects mapped from snake_case rows. ULID-generated IDs.

**Key files**: `src/memory/db.ts`, `src/memory/migrations/001_init.sql`, `src/memory/repositories/`

### 1.8 Debate Orchestrator ✅

`Debate` class with freeform mode (sequential turn order within each round). Translates `EngineEvent` → `DebateEvent` discriminated union. Emits: `panel.assembled`, `round.start`, `turn.start`, `turn.delta*`, `turn.end`, `cost.update`, `round.end`, `debate.end`. Errors are non-terminal at the debate level.

**Key files**: `src/core/debate.ts`, `src/core/types.ts`

### 1.9 Pluggable Renderers ✅

`Renderer` interface with `Sink` abstraction. `PlainRenderer` (human-readable with ANSI color, streams `turn.delta` immediately) and `JsonRenderer` (NDJSON, one event per line for CI/scripts/pipes).

**Key files**: `src/cli/renderers/types.ts`, `src/cli/renderers/plain.ts`, `src/cli/renderers/json.ts`

### 1.10 Core CLI Commands ✅

`council convene`, `council panels`, `council templates`, `council doctor` wired as Commander.js subcommands. `convene` runs the full pipeline: template → prompts → DB → engine → Debate → DebatePersister → Renderer. Engine selection is explicit (`--engine mock|copilot`).

**Key files**: `src/bin/council.ts`, `src/cli/commands/convene.ts`, `src/cli/commands/panels.ts`, `src/cli/commands/templates.ts`, `src/cli/commands/doctor.ts`

### 1.11 Built-in Panel Templates ✅

5 YAML panel definitions with distinct expertise priors, epistemic stances, and debate protocols. Zod-validated with duplicate-slug check. Path resolution probes multiple candidate directories for `panels/`.

**Panels**: `architecture-review`, `startup-validation`, `code-review`, `incident-postmortem`, `career-coaching`

**Key files**: `panels/*.yaml`, `src/core/template-loader.ts`

### 1.12 Doctor Command ✅

5 diagnostics: Node version, Council home directory, libsql in-memory open, Copilot SDK importable, disk-write check. Reports ✅/❌ per check.

**Key files**: `src/cli/commands/doctor.ts`

### 1.13 Cost Estimation ✅

`estimateDebateCost(input, expertCount)` with total premium-request count and per-phase breakdown. `formatCostBreakdown()` renders multi-line plain text. Emitted as `cost.update` DebateEvents during debates.

**Key files**: `src/core/cost.ts`

---

## Phase 2: Deliberation Quality ✅

> **Goal**: Deeper, more useful debates through structured modes, smarter moderation, and better context management.
>
> **Status**: Complete. All 7 items shipped.

### 2.1 Individual Expert Chat ✅

`council ask <panel> "<question>" [--expert <slug>] [--engine <kind>]` — one-shot single-expert chat. Picks one expert from an existing panel, runs a 1-round 1-expert debate through the full pipeline, and returns. Creates a new debate row visible in `resume`, `export`, `memory`. Uses `formatEngineError` for actionable CLI messages.

**Key files**: `src/cli/commands/ask.ts`

### 2.2 Structured Debate Engine ✅

`mode: "structured"` runs a fixed 4-phase choreography (opening → cross-examination → rebuttal → synthesis) regardless of `maxRounds`. Phase ordering is strict: phase N+1 starts only after phase N completes for every expert. Single-expert panels skip cross-exam (3 phases). Deterministic phase-prompt builders (no LLM moderator yet — see §2.3 follow-up).

**Key files**: `src/core/debate.ts`, `src/core/moderator/phase-prompts.ts`, `src/core/types.ts` (`DebatePhase`)

### 2.3 Pluggable Moderator Strategies ✅

`ModeratorStrategy` interface with `planRound()` and `shouldContinue()` methods. Strategies are pure (no I/O) — testable and MockEngine-compatible. Built-in strategies: `round-robin` (default), `sequential-with-visibility`, `devils-advocate`, `socratic`, `consensus-check`.

**Key files**: `src/core/moderator/strategy.ts`, `src/core/moderator/strategies.ts`, `src/cli/strategy-resolver.ts`

Strategies are wired into `Debate.#runFreeform()` via `DebateConfig.strategy` (default: `createRoundRobinStrategy()`). The CLI exposes `--strategy <name>` on `council convene` and `council resume --continue`; structured mode ignores the flag by design. The resolved strategy name is persisted to `debates.moderator`.

### 2.4 Anti-sycophancy Enforcement ✅

Heuristic quality gate inspecting expert responses against the 3-layer system: forbidden phrases, disagreement budget (when prior speakers exist), minimum specificity. Produces a `regenerateHint` for the orchestrator to pass back on the next attempt.

**Key files**: `src/core/quality-gate.ts`

### 2.5 Panel Auto-composition ✅

> Meta-prompt that analyzes a topic and suggests an expert panel (roles, models, expected disagreements).

`council convene "<topic>"` without `--template` auto-generates a relevant panel via an LLM meta-prompt. The generated panel is validated against `PanelDefinitionSchema`; on failure or refusal (trivial/factual questions) it falls back to a default panel. `--template` takes precedence.

**Key files**: `src/core/auto-compose.ts`, `src/cli/commands/convene.ts`

### 2.6 Context Window Management ✅

> Smart context scoping so experts see only what's relevant and long debates don't overflow.

Visibility scoping (`all` / `same-round` / `recent`), heuristic rolling summaries, and an opt-in `maxPromptChars` cap with newest-first eviction. CLI flags: `--context-scope`, `--summarize-after`.

**Key files**: `src/core/context/visibility.ts`, `src/core/context/summarizer.ts`, `src/core/context/budget.ts`

### 2.7 `council conclude` Command ✅

> The signature interaction: produces a decision matrix from the debate.

`council conclude [--panel <name>]` synthesizes debate positions into an actionable decision framework: consensus points, unresolved tensions, decision matrix (option × dimension), and recommendation with confidence level. Works on completed or in-progress debates. JSON output is machine-parseable.

**Key files**: `src/cli/commands/conclude.ts`

---

## Phase 3: Persistence & Polish ✅

> **Goal**: Experts remember, sessions persist, and the UX is polished.
>
> **Status**: Complete. All 7 items shipped.

### 3.1 Persistent Expert Memory ✅

> Experts remember positions, updated priors, and unresolved questions across sessions.

`DebatePersister` writes debate/turn rows to SQLite; `src/memory/expert-memory.ts` extracts positions, updated priors, and unresolved questions from prior debate turns for a given expert. The prompt builder reads memory and populates section [7] MEMORY with a terse bulleted log, sanitized against prompt-injection. `council memory inspect <panel> --expert <slug>` displays the injected memory content.

**Key files**: `src/memory/expert-memory.ts`, `src/memory/persister.ts`, `src/core/prompt-builder.ts`, `src/cli/commands/memory.ts`

### 3.2 Session Resume ✅

`council resume <panel>` — transcript mode (default) replays persisted turns via synthesized `DebateEvent` stream. Continue mode (`--continue "<prompt>"`) runs a new debate against the same panel/experts. Honors the panel's persisted `mode` (freeform or structured). Engine selection required for `--continue`.

**Key files**: `src/cli/commands/resume.ts`, `src/memory/transcript.ts`

### 3.3 Human-as-expert ✅

`council convene --human "<name>"` adds a human participant. Human turns are collected interactively via `HumanInputProvider` interface. Persisted with `speakerKind: "human"`. `PlainRenderer` shows `[You]` prefix. Repeatable flag for multiple humans. Does not count as premium requests in cost tracking.

**Key files**: `src/core/human-input.ts`, `src/cli/commands/convene.ts`

### 3.4 Rich Ink Terminal UI ✅

> React + Ink components for a polished interactive TUI.

When stdout is a TTY, Council renders a rich Ink UI with color-coded experts, streaming text, and a panel picker for `council resume`. Non-TTY environments fall back to `PlainRenderer`. `--format json` and `--format plain` override even on TTY.

**Key files**: `src/cli/renderers/ink/`

### 3.5 Memory Inspection CLI ✅

`council memory list` (per-panel summary), `memory inspect <panel>` (detailed panel/expert view with truncated system prompt), `memory reset <panel> --yes` (destructive cleanup with `--hard` and `--expert <slug>` options). Flag-only safety gate — no interactive prompt.

**Key files**: `src/cli/commands/memory.ts`

### 3.6 Export System ✅

`council export <panel> --format markdown|json|adr [--output <path>]`. Markdown (readable transcript), JSON (NDJSON), ADR (Architecture Decision Record with Status/Context/Options/Discussion/Decision sections). Shared `loadTranscript()` + `synthesizeEvents()` with `resume`.

**Key files**: `src/cli/commands/export.ts`, `src/memory/transcript.ts`

### 3.7 Error Resilience ✅

Automatic retry (2× with exponential backoff: 250ms, 1s) on recoverable engine errors (RATE_LIMITED, NETWORK). Non-recoverable errors fail fast. `turn.retry` DebateEvent variant. `formatEngineError()` maps `EngineErrorCode` → actionable user messages. Wired into `convene` and `resume`.

**Key files**: `src/core/debate.ts`, `src/cli/error-mapper.ts`

**Deferred**: model fallback per expert config (needs `ExpertDefinitionSchema` changes — separate PR).

---

## Phase 4: Growth & Ecosystem ⬜

> **Goal**: Meet users where they are — GitHub, CI, and beyond Copilot.
>
> **Status**: Not started.

### 4.1 `gh` CLI Extension ⬜

> Package Council as a GitHub CLI extension (`gh council`).

**Goal**: `gh council convene "..." --template code-review` runs Council as a `gh` extension, making it installable via `gh extension install`.

**Proposed implementation**:
- Thin wrapper that delegates to the `@council/cli` binary
- Extension manifest for `gh extension install pedrofuentes/gh-council`
- Leverage `gh` auth context (Copilot token passthrough)

**Acceptance criteria**:
- `gh extension install pedrofuentes/gh-council` works
- `gh council convene "topic"` produces the same output as `council convene "topic"`
- Auth flows through `gh` — no separate Copilot login needed

### 4.2 GitHub Action ⬜

> Run Council panels as part of CI workflows.

**Goal**: `pedrofuentes/council-action@v1` GitHub Action for automated deliberation in CI (e.g., architecture review on PR diff).

**Proposed implementation**:
- GitHub Action that runs `council convene` with PR diff as context
- Outputs: structured JSON for downstream steps, PR comment with synthesis
- Configurable: template, max-rounds, model, output format
- Token-limited mode for cost control in CI

**Acceptance criteria**:
- Action runs successfully in a GitHub Actions workflow
- PR diff is injected as topic context
- Output is available as step output and optional PR comment
- Cost estimation available before running

### 4.3 Opt-in Telemetry ⬜

> Anonymous usage metrics for understanding adoption and quality.

**Goal**: Opt-in anonymous telemetry (disabled by default, per `config.yaml`).

**Proposed implementation**:
- `src/telemetry/` — pino-based logger with file sink
- Events: debate-started, debate-completed, expert-count, round-count, engine-type, error-codes
- No PII, no prompt content, no response content
- `council config set telemetry.enabled true` to opt in

**Acceptance criteria**:
- Disabled by default (zero telemetry without explicit opt-in)
- Telemetry flag in `ConfigSchema` (already stubbed)
- No performance impact when disabled
- Clear privacy policy in README

### 4.4 Direct Provider APIs ⬜

> Support OpenAI, Anthropic, Google APIs directly (not through Copilot SDK).

**Goal**: Users without GitHub Copilot can use Council with their own API keys.

**Proposed implementation**:
- `src/engine/openai/adapter.ts` — `OpenAIEngine` implementing `CouncilEngine`
- `src/engine/anthropic/adapter.ts` — `AnthropicEngine` implementing `CouncilEngine`
- Engine selection: `--engine copilot` (default), `--engine openai`, `--engine anthropic`
- API keys via environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`)
- Same `EngineEvent` stream — renderers and persistence work unchanged

**Acceptance criteria**:
- At least one direct provider adapter (OpenAI or Anthropic) passes the same test suite as MockEngine/CopilotEngine
- `council doctor` checks for provider API key when the corresponding engine is configured
- Mixed-model panels work (some experts via Copilot, some via direct API)

---

## Key Milestones

| Milestone | Phase | Status |
|-----------|-------|--------|
| `pnpm build && pnpm test` pass | 1.1 | ✅ Done |
| `council convene "topic"` produces multi-expert debate | 1.10 | ✅ Done |
| Structured 4-phase choreography | 2.2 | ✅ Done |
| Individual expert chat works | 2.1 | ✅ Done |
| Pluggable moderator strategies defined | 2.3 | ✅ Done |
| Anti-sycophancy quality gate | 2.4 | ✅ Done |
| Session resume + export + memory CLI | 3.2/3.5/3.6 | ✅ Done |
| Error resilience with retry | 3.7 | ✅ Done |
| Human-as-expert | 3.3 | ✅ Done |
| Experts remember across sessions | 3.1 | ✅ Done |
| `council conclude` with decision matrix | 2.7 | ✅ Done |
| Context window management | 2.6 | ✅ Done |
| Panel auto-composition | 2.5 | ✅ Done |
| Rich Ink terminal UI | 3.4 | ✅ Done |
| `gh` CLI extension | 4.1 | ⬜ Planned |
| GitHub Action | 4.2 | ⬜ Planned |
| Direct provider APIs | 4.4 | ⬜ Planned |
| Published to npm as `@council/cli` | 4 | ⬜ Planned |
