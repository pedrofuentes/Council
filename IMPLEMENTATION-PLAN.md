# Implementation Plan — Council

> Implementation-level detail for each roadmap item. For the high-level overview, see [ROADMAP.md](./ROADMAP.md).

---

## Phase 1: Foundation ✅

> **Goal**: `council convene "topic"` produces a useful multi-expert discussion in the terminal.
>
> **Status**: Complete. All 13 items shipped.

### 1.1 Project Scaffolding ✅

TypeScript ESM project (Node 20+) with tsup bundler, Vitest test runner, ESLint flat config v9 (typescript-eslint strict), and Prettier. CLI binary entry via Commander.js. Packaged as `@council/cli` with `council` binary (not yet published to npm — see Phase 8).

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

`ModeratorStrategy` interface with `planRound()` and `shouldContinue()` methods. Strategies are pure (no I/O) — testable and MockEngine-compatible. Built-in strategies: `round-robin` (default), `devils-advocate`, `consensus-check`.

**Key files**: `src/core/moderator/strategy.ts`, `src/core/moderator/strategies.ts`, `src/cli/strategy-resolver.ts`

Strategies are wired into `Debate.#runFreeform()` via `DebateConfig.strategy` (default: `createRoundRobinStrategy()`). The CLI exposes `--strategy <name>` on `council convene` and `council resume --continue`; structured mode ignores the flag by design. The resolved strategy name is persisted to `debates.moderator`.

### 2.4 Anti-sycophancy Enforcement ✅

Heuristic quality gate inspecting expert responses against the 3-layer system: forbidden phrases, disagreement budget (when prior speakers exist), minimum specificity. Produces a `regenerateHint` for the orchestrator to pass back on the next attempt.

**Key files**: `src/core/quality-gate.ts`

### 2.5 Panel Auto-composition ✅

> Meta-prompt that analyzes a topic and suggests an expert panel (roles, models, expected disagreements).

`council convene "<topic>"` without `--template` auto-generates a relevant panel via an LLM meta-prompt. The generated panel is validated against `PanelDefinitionSchema`; on validation failure or model refusal the command throws a user-facing error directing the user to specify `--template` manually. `--template` takes precedence when provided. An interactive confirmation prompt displays the composed panel and requires explicit `y` to proceed; `--yes` bypasses the prompt for scripting/CI.

**Key files**: `src/core/auto-compose.ts`, `src/cli/commands/convene.ts`

### 2.6 Context Window Management ✅

> Smart context scoping so experts see only what's relevant and long debates don't overflow.

Visibility scoping (`all` / `same-round` / `recent`), LLM-based rolling summaries (default), and an opt-in `maxPromptChars` cap with newest-first eviction. CLI flags: `--context-scope`, `--summarize-after`, `--heuristic-summaries` (falls back to heuristic first-sentence extraction for token-saving).

**Key files**: `src/core/context/visibility.ts`, `src/core/context/summarizer.ts`, `src/core/debate.ts` (`capByChars` eviction)

### 2.7 `council conclude` Command ✅

> The signature interaction: produces a decision matrix from the debate.

`council conclude [panel] --engine <kind>` synthesizes debate positions into an actionable decision framework: consensus points, unresolved tensions, decision matrix (option × dimension), and recommendation with confidence level. Works on completed or in-progress debates. JSON output is machine-parseable.

**Key files**: `src/cli/commands/conclude.ts`

---

## Phase 3: Persistence & Polish ✅

> **Goal**: Experts remember, sessions persist, and the UX is polished.
>
> **Status**: Complete. All 7 items shipped.

### 3.1 Persistent Expert Memory ✅

> Experts remember positions, updated priors, and unresolved questions across sessions.

`DebatePersister` writes debate/turn rows to SQLite. After each debate completes, an LLM-based extractor (`src/memory/memory-extractor.ts`) runs against each expert's turns to produce a structured `ExpertMemory` (positions, updated priors, unresolved questions), which is cached in `experts.extracted_memory_json`. At the next `convene`, the cached memory is loaded directly (no LLM call). The prompt builder reads memory and populates section [7] MEMORY with a terse bulleted log, sanitized against prompt-injection. `--heuristic-memory` flag skips LLM extraction and uses heuristic first-sentence extraction instead. `council memory inspect <panel> --expert <slug>` displays the injected memory content.

**Key files**: `src/memory/expert-memory.ts`, `src/memory/memory-extractor.ts`, `src/memory/persister.ts`, `src/core/prompt-builder.ts`, `src/cli/commands/memory.ts`

### 3.2 Session Resume ✅

`council resume <panel>` — transcript mode (default) replays persisted turns via synthesized `DebateEvent` stream. Continue mode (`--continue "<prompt>"`) runs a new debate against the same panel/experts. Honors the panel's persisted `mode` (freeform or structured). Engine selection required for `--continue`.

**Key files**: `src/cli/commands/resume.ts`, `src/memory/transcript.ts`

### 3.3 Human-as-expert ✅

`council convene --human "<name>"` adds a human participant. Human turns are collected interactively via `HumanInputProvider` interface. Persisted with `speakerKind: "human"`. `PlainRenderer` shows `[You]` prefix. Repeatable flag for multiple humans. Does not count as premium requests in cost tracking.

**Key files**: `src/core/human-input.ts`, `src/cli/commands/convene.ts`

### 3.4 Rich Ink Terminal UI ✅

> React + Ink components for a polished interactive TUI.

When stdout is a TTY, Council renders a rich Ink UI with color-coded experts and streaming text. Non-TTY environments fall back to `PlainRenderer`. `--format json` and `--format plain` override even on TTY. (An interactive panel picker for `council resume` remains deferred.)

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

## Phase 4: Expert Library Foundation ✅

> **Goal**: Promote experts to first-class, standalone entities — the prerequisite for chat, persona experts, and cross-panel awareness.
>
> **Status**: Complete. All 7 items shipped.

### 4.1 Expert YAML Schema & Storage ✅

Standalone expert YAML files at `~/Council/experts/<slug>.yaml` validated by `ExpertDefinitionSchema` (Zod). Each expert has stable slug, display name, expertise priors, and (for persona experts) a `persona` block. Experts are loaded by `ExpertLibrary` and reused across panels.

**Key files**: `src/core/expert.ts`, `src/core/expert-library.ts`

### 4.2 Panel Composition Model ✅

Panel YAML decoupled from inline expert definitions — panels reference experts by slug. Updates to an expert propagate to every panel that references it. Panel schema also stores moderator strategy and round budget.

**Key files**: `src/core/template-loader.ts`, `src/core/types.ts`

### 4.3 Expert CLI Commands ✅

`council expert create | list | inspect | edit | delete` for managing the expert library. `create` supports both generic and persona templates. `inspect` shows the rendered system prompt for debugging.

**Key files**: `src/cli/commands/expert.ts`

### 4.4 Panel CLI Commands (Updated) ✅

`council panel create | list | inspect | edit | delete` over the slug-referencing panel model. Replaces the older inline-expert workflow.

**Key files**: `src/cli/commands/panel.ts`

### 4.5 User Data Directory ✅

User-facing layout at `~/Council/` (`experts/`, `panels/`) replacing the opaque `~/.council/` data dir for human-editable assets. The runtime DB and cache stay under `~/.council/`. `COUNCIL_HOME` continues to override both for tests.

**Key files**: `src/config/loader.ts`, `src/config/schema.ts`

### 4.6 Template Migration ✅

The 5 built-in panel templates (architecture, startup, code-review, incident, career) migrated to the new expert+panel split with deterministic slugs. One-shot migration helper backfills user-defined panels.

**Key files**: `src/core/template-migration.ts`, `src/cli/commands/templates.ts`

### 4.7 Schema Migration 004 ✅

`004_expert_library.sql` — adds `expert_library`, `panel_library`, and `panel_members` tables (the panel-membership join required for cross-panel awareness in Phase 7). Applied automatically on first run after upgrade.

**Key files**: `src/memory/migrations/004_expert_library.sql`

---

## Phase 5: Conversational Experience ✅

> **Goal**: Persistent chat — both 1:1 with an expert and multi-expert panel chat — with smart context handling and inline structured debates.
>
> **Status**: Complete. All 7 items shipped.

### 5.1 Chat Session Infrastructure ✅

`ChatSession` model and `chat_sessions` / `chat_turns` tables (`005_chat.sql`). Sessions are scoped to either a single expert or a panel and can be resumed across CLI invocations. Repository encapsulates persistence and pagination.

**Key files**: `src/core/chat/chat-session.ts`, `src/memory/repositories/chat-repository.ts`, `src/memory/migrations/005_chat.sql`

### 5.2 1:1 Expert Chat ✅

`council chat <expert-slug>` opens a persistent single-expert conversation. Streams responses via the `CouncilEngine` event stream, persists each turn, and resumes the most recent session by default (`--new` to start fresh).

**Key files**: `src/cli/commands/chat.ts`

### 5.3 Context Management ✅

Shared context manager between debate and chat: rolling LLM-based summaries for older turns plus full recent turns. Honors the existing `maxPromptChars` cap with newest-first eviction. Heuristic summarization remains available via `--heuristic-summaries`.

**Key files**: `src/core/chat/context-manager.ts`, `src/core/context/`

### 5.4 Panel Chat Mode ✅

`council chat <panel>` enables multi-expert conversation. A lightweight moderator selects the next responder per turn (round-robin by default; configurable). Each expert sees the panel-shared transcript filtered by visibility scope.

**Key files**: `src/cli/commands/chat.ts`, `src/core/moderator/`

### 5.5 @Mention Support ✅

`@<expert-slug>` in a chat message directs the next turn at a specific panel member, bypassing moderator rotation. Parser validates slugs against current panel membership and surfaces helpful errors.

**Key files**: `src/core/chat/mention-parser.ts`

### 5.6 Inline Structured Debate ✅

`@convene <topic>` inside a chat triggers a 4-phase structured debate (opening → cross-exam → rebuttal → synthesis), then resumes the chat session with the debate summary attached as context.

**Key files**: `src/cli/commands/chat.ts`, `src/core/debate.ts`

### 5.7 Chat Renderer ✅

Ink-based chat UI with streaming text, color-coded experts, `@mention` highlighting, and inline debate phase indicators. Reuses primitives from the Phase 3 debate renderer.

**Key files**: `src/cli/renderers/chat-renderer.ts`

---

## Phase 6: Document Intelligence ✅

> **Goal**: Persona experts grounded in user-supplied documents, plus panel-level document folders for shared context. RAG retrieval during conversations.
>
> **Status**: 7 of 8 items shipped. 6.5 deferred.

### 6.1 Document Detection & Extraction ✅

Detects supported formats (`.md`, `.txt`, `.html`) under an expert's or panel's `docs/` folder and extracts text content via regex normalisers (see ADR-009). Tracks file checksum (SHA-256) and word count in `expert_documents` / `panel_documents` to skip unchanged files. PDF and DOCX formats are NOT supported in Phase 6; reserved for Phase 8.

**Key files**: `src/core/documents/detector.ts`, `src/core/documents/extractor.ts`

### 6.2 Persona Profile Analysis ✅

LLM-based profile synthesis from documents into the expert's persona section of the system prompt. Profiles are cached in `persona_profiles` (`008_persona_profiles.sql`) and re-generated when source documents change.

**Key files**: `src/core/documents/profile-analyzer.ts`, `src/memory/migrations/008_persona_profiles.sql`

### 6.3 Content Indexing (RAG) ✅

Documents are chunked and indexed into a SQLite FTS5 virtual table (`007_document_index.sql`). The retriever ranks chunks using FTS5's built-in BM25 scoring against the current turn and injects top-k snippets into the prompt.

**Key files**: `src/core/documents/indexer.ts`, `src/core/documents/retriever.ts`, `src/memory/migrations/007_document_index.sql`

### 6.4 On-demand Processing ✅

Document processing runs lazily on first use (chat or debate) with visible progress feedback in the CLI. The processor coordinates extraction → profile analysis → indexing and short-circuits when nothing has changed.

**Key files**: `src/core/documents/processor.ts`

### 6.5 Background Processing ⏳ Deferred

A daemon-style background processor for document changes was scoped but **deferred**. On-demand processing (6.4) covers the primary use case for a CLI tool, and a long-lived background process adds installation, lifecycle, and platform-compatibility complexity disproportionate to its incremental value. Revisit if document corpora grow large enough that first-use latency becomes a real problem.

### 6.6 Expert Document CLI ✅

`council expert docs add | list | remove | reprocess` for managing an expert's persona document folder. `add` symlinks/copies into `~/Council/experts/<slug>/docs/`; `reprocess` forces re-extraction and re-indexing.

**Key files**: `src/cli/commands/expert.ts`

### 6.7 Panel Document Folder ✅

`~/Council/panels/<panel>/docs/` and `council panel docs link/unlink` for shared panel context (`009_panel_documents.sql`). Panel documents are visible to every member during chat and debate.

**Key files**: `src/cli/commands/panel.ts`, `src/core/documents/panel-document-scanner.ts`, `src/memory/migrations/009_panel_documents.sql`

### 6.8 Recency Weighting ✅

Newer documents are weighted higher when the persona-profile analyzer
distills the corpus, biasing the resulting profile toward the most
recent material — important when a user adds an updated CV, design
doc, or RFC alongside older versions.

**Mechanism (prompt-side annotation, not input ordering or retrieval
scoring).** Recency weighting is applied at *analyzer prompt
construction* time. `analyzeDocuments()` (in
`src/core/documents/profile-analyzer.ts`) annotates each fenced
document block with a `[Weight: 0.NN]` tag computed via exponential
decay: `weight = 2^(-ageDays / halfLifeDays)` (so age = 0 → 1.0,
age = halfLife → 0.5, age = 2 × halfLife → 0.25). The meta-prompt
explicitly instructs the LLM to weight more-recent material more
heavily when distilling `communicationStyle`, `decisionPatterns`, etc.
The analyzer preserves the caller's input order — it does NOT itself
sort by `modifiedAt`. The FTS5 retriever
(`src/core/documents/retriever.ts`) is unchanged — BM25 ranking is
still purely lexical.

Half-life is configurable via `AnalyzeOptions.recencyWeightHalfLife`
(`DocumentProcessor` default: 90 days). Edge cases: `halfLifeDays <= 0`
clamps every weight to 1.0 (a misconfigured value cannot zero out every
document); future-dated `modifiedAt` clamps to 1.0; documents without a
`modifiedAt` render without a weight tag (back-compat). The reference
"now" is injectable via `AnalyzeOptions.now` for deterministic tests.

**Key files**: `src/core/documents/profile-analyzer.ts`
(`calculateRecencyWeight`, prompt-tag emission); consumed via
`AnalyzeOptions.recencyWeightHalfLife` from
`src/core/documents/processor.ts`.

---

## Phase 7: Context & Awareness ✅

> **Goal**: Final polish — strict memory boundaries by expert kind, plus cross-panel awareness so experts know which other panels they participate in.
>
> **Status**: Complete. All 4 items shipped.

### 7.1 Memory Model Enforcement ✅

Generic experts get debate memory only; persona experts get document + debate memory. Enforced inside the prompt builder so no caller can accidentally leak the wrong memory kind into a prompt.

**Key files**: `src/core/prompt-builder.ts`

### 7.2 Cross-Panel Awareness ✅

1:1 chat surfaces a summary of the expert's other panels and recent cross-panel activity, so the expert can reference shared context across panels without re-introduction.

**Key files**: `src/cli/commands/chat.ts`, `src/core/prompt-builder.ts`

### 7.3 Panel Membership Tracking ✅

`panel-membership-query` resolves the panels an expert belongs to and injects that list (with roles) into the prompt's `MEMBERSHIP` section.

**Key files**: `src/core/panel-membership-query.ts`

### 7.4 Memory/Profile Separation ✅

`council memory reset` clears extracted debate memory (`extracted_memory_json`) but preserves persona profiles, so resetting an expert's debate history does not require re-processing their documents.

**Key files**: `src/cli/commands/memory.ts`, `src/memory/expert-memory.ts`

---

## Phase 8: Growth & Ecosystem ⬜

> **Goal**: Meet users where they are — GitHub, CI, and beyond Copilot.
>
> **Status**: Not started.

### 8.1 `gh` CLI Extension ⬜

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

### 8.2 GitHub Action ⬜

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

### 8.3 Opt-in Telemetry ⬜

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

### 8.4 Direct Provider APIs ⬜

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
| Experts as standalone reusable entities | 4 | ✅ Done |
| Persistent 1:1 and panel chat | 5 | ✅ Done |
| Document-driven persona experts | 6 | ✅ Done (6.5 deferred) |
| Cross-panel expert awareness | 7 | ✅ Done |
| `gh` CLI extension | 8.1 | ⬜ Planned |
| GitHub Action | 8.2 | ⬜ Planned |
| Direct provider APIs | 8.4 | ⬜ Planned |
| Published to npm as `@council/cli` | 8 | ⬜ Planned |
