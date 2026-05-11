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

## Phase 2: Deliberation Quality 🚧

> **Goal**: Deeper, more useful debates through structured modes, smarter moderation, and better context management.
>
> **Status**: 4 of 7 items complete. Remaining: auto-composition, context management, `conclude`.

### 2.1 Individual Expert Chat ✅

`council ask <panel> "<question>" [--expert <slug>] [--engine <kind>]` — one-shot single-expert chat. Picks one expert from an existing panel, runs a 1-round 1-expert debate through the full pipeline, and returns. Creates a new debate row visible in `resume`, `export`, `memory`. Uses `formatEngineError` for actionable CLI messages.

**Key files**: `src/cli/commands/ask.ts`

### 2.2 Structured Debate Engine ✅

`mode: "structured"` runs a fixed 4-phase choreography (opening → cross-examination → rebuttal → synthesis) regardless of `maxRounds`. Phase ordering is strict: phase N+1 starts only after phase N completes for every expert. Single-expert panels skip cross-exam (3 phases). Deterministic phase-prompt builders (no LLM moderator yet — see §2.3 follow-up).

**Key files**: `src/core/debate.ts`, `src/core/moderator/phase-prompts.ts`, `src/core/types.ts` (`DebatePhase`)

### 2.3 Pluggable Moderator Strategies ✅

`ModeratorStrategy` interface with `planRound()` and `shouldContinue()` methods. Strategies are pure (no I/O) — testable and MockEngine-compatible. Built-in strategies: `round-robin` (default), `sequential-with-visibility`, `devils-advocate`, `socratic`, `consensus-check`.

**Key files**: `src/core/moderator/strategy.ts`, `src/core/moderator/strategies.ts`

**Note**: Strategies are not yet wired into `Debate.run()` — see issue #212. Currently the orchestrator uses its own internal turn logic.

### 2.4 Anti-sycophancy Enforcement ✅

Heuristic quality gate inspecting expert responses against the 3-layer system: forbidden phrases, disagreement budget (when prior speakers exist), minimum specificity. Produces a `regenerateHint` for the orchestrator to pass back on the next attempt.

**Key files**: `src/core/quality-gate.ts`

### 2.5 Panel Auto-composition ⬜

> Meta-prompt that analyzes a topic and suggests an expert panel (roles, models, expected disagreements).

**Goal**: `council convene "Should we go public?"` without `--template` auto-generates a relevant panel via an LLM meta-prompt.

**Proposed implementation**:
- `src/core/auto-compose.ts` — `autoComposePanel(topic, engine, config): Promise<PanelDefinition>`
- Meta-prompt asks the engine to suggest 3–5 experts with distinct epistemic stances and expected disagreements
- Output is a JSON panel spec validated against `PanelDefinitionSchema`
- User can accept, modify, or override before debate starts
- Can refuse for trivial/factual questions (suggests `council ask` instead)

**Acceptance criteria**:
- Generated panel passes Zod validation
- Experts have non-overlapping expertise priors
- Fallback to default panel on meta-prompt failure
- `--template` flag takes precedence (auto-compose only when no template specified)

### 2.6 Context Window Management ⬜

> Smart context scoping so experts see only what's relevant and long debates don't overflow.

**Goal**: Enable debates of arbitrary length without context overflow or degraded quality.

**Proposed implementation**:
- **Visibility scoping**: `src/core/context/visibility.ts` — each expert sees only relevant prior turns (configurable: all, same-round, addressed-to-me)
- **Rolling summaries**: `src/core/context/summarizer.ts` — moderator produces 3–5 sentence round summary for injection into subsequent rounds. Uses a low-cost model call. Summary replaces verbatim prior turns after N rounds.
- **Token budgets**: configurable cap per expert per turn in `DebateConfig`. Emit warning event when approaching limit.
- **Integration with `infiniteSessions`**: leverage Copilot SDK's built-in session compaction for long-running expert sessions

**Dependencies**: Moderator strategies (§2.3) wired into Debate (issue #212)

**Acceptance criteria**:
- 10-round debate with 4 experts completes without context overflow
- Summaries are injected after configurable threshold (default: round 3)
- Per-expert token budget is enforced with graceful truncation
- Unit tests using MockEngine verify visibility scoping rules

### 2.7 `council conclude` Command ⬜

> The signature interaction: produces a decision matrix from the debate.

**Goal**: `council conclude [--panel <name>]` synthesizes debate positions into an actionable decision framework.

**Proposed implementation**:
- `src/cli/commands/conclude.ts` — reads latest debate transcript, runs a synthesis prompt through the engine
- **Output structure**: consensus points, unresolved tensions, decision matrix (option × dimension), recommendation with confidence level
- **Formats**: plain text (default), markdown, JSON
- Can be called mid-debate or at end
- Uses its own LLM call (not an expert turn) — the moderator synthesizes

**Acceptance criteria**:
- Produces structured output with consensus/tensions/recommendation sections
- Decision matrix includes at least the dimensions each expert weighted
- Works on completed and in-progress debates
- JSON output is machine-parseable for downstream tooling

---

## Phase 3: Persistence & Polish 🚧

> **Goal**: Experts remember, sessions persist, and the UX is polished.
>
> **Status**: 5 of 7 items complete. Remaining: expert memory recall, Ink TUI.

### 3.1 Persistent Expert Memory 🚧

> Experts remember positions, updated priors, and unresolved questions across sessions.

**Shipped**: Foundation — `DebatePersister` writes debate/turn rows to SQLite (PR #116). Section [7] MEMORY placeholder exists in prompt builder.

**Remaining**:
- **Memory recall**: `src/memory/expert-memory.ts` — extract positions, updated priors, and unresolved questions from prior debate turns for a given expert
- **Memory injection**: prompt builder reads memory from SQLite and populates section [7] with terse bulleted log
- **Memory format**: `ExpertMemory` type — `{ positions: string[], updatedPriors: string[], unresolvedQuestions: string[] }`
- **Summarization**: optionally run a low-cost LLM call to compress raw turn content into structured memory (vs. heuristic extraction)

**Acceptance criteria**:
- Expert's second debate references positions from first debate
- Memory is injected as section [7] in system prompt
- Stale memory (>N debates old) is deprioritized or summarized
- `council memory inspect <panel> --expert <slug>` shows injected memory content

### 3.2 Session Resume ✅

`council resume <panel>` — transcript mode (default) replays persisted turns via synthesized `DebateEvent` stream. Continue mode (`--continue "<prompt>"`) runs a new debate against the same panel/experts. Honors the panel's persisted `mode` (freeform or structured). Engine selection required for `--continue`.

**Key files**: `src/cli/commands/resume.ts`, `src/memory/transcript.ts`

### 3.3 Human-as-expert ✅

`council convene --human "<name>"` adds a human participant. Human turns are collected interactively via `HumanInputProvider` interface. Persisted with `speakerKind: "human"`. `PlainRenderer` shows `[You]` prefix. Repeatable flag for multiple humans. Does not count as premium requests in cost tracking.

**Key files**: `src/core/human-input.ts`, `src/cli/commands/convene.ts`

### 3.4 Rich Ink Terminal UI ⬜

> React + Ink components for a polished interactive TUI.

**Goal**: When stdout is a TTY, render a rich interactive UI instead of plain text.

**Proposed implementation**:
- `src/cli/renderers/ink/` — React components using Ink framework
- **Components**: ExpertCard (color-coded), StreamingText (typewriter effect), RoundSeparator, CostBar, PanelPicker (for `council resume`)
- **Features**: expert color coding, streaming text with spinner, progress indicator, interactive panel picker
- **Activation**: auto-selected when `process.stdout.isTTY` (already stubbed in renderer selection logic)

**Dependencies**: `ink`, `ink-spinner`, `react` (already in package.json as planned deps)

**Acceptance criteria**:
- TTY detection auto-selects Ink renderer
- Non-TTY environments fall back to PlainRenderer (existing behavior preserved)
- Expert responses stream with visual feedback
- Colors are consistent per-expert across rounds
- `--format json` and `--format plain` override Ink even on TTY

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
| Experts remember across sessions | 3.1 | 🚧 Foundation shipped |
| `council conclude` with decision matrix | 2.7 | ⬜ Planned |
| Context window management | 2.6 | ⬜ Planned |
| Panel auto-composition | 2.5 | ⬜ Planned |
| Rich Ink terminal UI | 3.4 | ⬜ Planned |
| `gh` CLI extension | 4.1 | ⬜ Planned |
| GitHub Action | 4.2 | ⬜ Planned |
| Direct provider APIs | 4.4 | ⬜ Planned |
| Published to npm as `@council/cli` | 4 | ⬜ Planned |
