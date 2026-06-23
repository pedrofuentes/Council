# Roadmap — Council

> High-level project roadmap. For implementation details, file references, and acceptance criteria, see [IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md).

**Legend**: ✅ Done · 🚧 In Progress · ⬜ Planned

---

## Phase 1: Foundation ✅

> `council convene "topic"` produces a useful multi-expert discussion in the terminal.

- ✅ **1.1 Project Scaffolding** — TypeScript ESM, tsup, Vitest, ESLint flat config, Prettier
- ✅ **1.2 CouncilEngine Interface** — Domain types and engine abstraction seam (ADR-003)
- ✅ **1.3 MockEngine** — Deterministic in-memory engine for unit tests
- ✅ **1.4 Copilot SDK Adapter** — `CopilotEngine` with isolated SDK imports (ADR-003/ADR-004)
- ✅ **1.5 Configuration System** — Zod-validated YAML config with sensible defaults
- ✅ **1.6 Expert System** — `ExpertDefinition` schema and 8-section prompt builder with anti-sycophancy
- ✅ **1.7 SQLite Schema** — libsql (pure WASM) + Kysely with FTS5 search (ADR-005)
- ✅ **1.8 Debate Orchestrator** — `Debate` class with freeform mode and `DebateEvent` stream
- ✅ **1.9 Pluggable Renderers** — Plain (streaming ANSI) and JSON (NDJSON) renderers
- ✅ **1.10 Core CLI Commands** — `convene`, `panels`, `templates`, `doctor` wired end-to-end
- ✅ **1.11 Built-in Panel Templates** — 5 YAML panels: architecture, startup, code-review, incident, career
- ✅ **1.12 Doctor Command** — 5-check diagnostic (Node, home dir, libsql, SDK, disk)
- ✅ **1.13 Cost Estimation** — Premium request estimation with per-phase breakdown

---

## Phase 2: Deliberation Quality ✅

> Deeper, more useful debates through structured modes, smarter moderation, and context management.

- ✅ **2.1 Individual Expert Chat** — `council ask` for one-shot single-expert queries
- ✅ **2.2 Structured Debate Engine** — 4-phase choreography (opening → cross-exam → rebuttal → synthesis)
- ✅ **2.3 Pluggable Moderator Strategies** — `ModeratorStrategy` interface with built-in strategies (`round-robin`, `devils-advocate`, `consensus-check`), wired into `Debate.#runFreeform()` and exposed via `--strategy` CLI flag
- ✅ **2.4 Anti-sycophancy Enforcement** — 3-layer quality gate (forbidden phrases, disagreement budget, specificity)
- ✅ **2.5 Panel Auto-composition** — LLM meta-prompt generates expert panels from topic analysis; interactive confirmation before proceeding (`--yes` to skip)
- ✅ **2.6 Context Window Management** — Visibility scoping (`all` / `same-round` / `recent`), LLM-based rolling summaries (default, `--heuristic-summaries` for token-saving), and an opt-in `maxPromptChars` cap with newest-first eviction
- ✅ **2.7 `council conclude` Command** — Decision matrix with consensus, tensions, and recommendation

---

## Phase 3: Persistence & Polish ✅

> Experts remember, sessions persist, and the UX is polished.

- ✅ **3.1 Persistent Expert Memory** — LLM-based post-debate extraction cached in DB (default, `--heuristic-memory` for token-saving), sanitized against prompt injection
- ✅ **3.2 Session Resume** — `council resume` for transcript replay and `--prompt` for new debates
- ✅ **3.3 Human-as-expert** — `council convene --human` adds interactive human participants
- ✅ **3.4 Rich Ink Terminal UI** — React + Ink components with color-coded experts and streaming text
- ✅ **3.5 Memory Inspection CLI** — `council memory list/inspect/reset` for panel/expert curation
- ✅ **3.6 Export System** — `council export` in markdown, JSON (NDJSON), and ADR formats
- ✅ **3.7 Error Resilience** — Retry with backoff, actionable error messages, graceful degradation

---

## Phase 4: Expert Library Foundation ✅

> Experts become first-class, standalone entities — the prerequisite for chat, persona experts, and cross-panel awareness.

- ✅ **4.1 Expert YAML Schema & Storage** — Standalone `expert` YAML files in `~/Council/experts/<slug>.yaml` with Zod validation
- ✅ **4.2 Panel Composition Model** — Panels reference experts by slug; panel YAML decoupled from expert definitions
- ✅ **4.3 Expert CLI Commands** — `council expert create | list | inspect | edit | delete`
- ✅ **4.4 Panel CLI Commands (Updated)** — `council panel create | list | inspect | edit | delete` over slug-referencing panels
- ✅ **4.5 User Data Directory** — `~/Council/` user-facing layout (`experts/`, `panels/`) replaces opaque `~/.council/`
- ✅ **4.6 Template Migration** — 5 built-in panels migrated to the new expert+panel split with deterministic slugs
- ✅ **4.7 Schema Migration 004** — `expert_library`, `panel_library`, and `panel_members` tables (`001_unified.sql`)

---

## Phase 5: Conversational Experience ✅

> Persistent chat — both 1:1 with an expert and multi-expert panel chat — with smart context handling and inline structured debates.

- ✅ **5.1 Chat Session Infrastructure** — `ChatSession` model + `chat_sessions` / `chat_turns` tables (`001_unified.sql`)
- ✅ **5.2 1:1 Expert Chat** — `council chat <expert-slug>` for persistent single-expert conversation
- ✅ **5.3 Context Management** — Rolling LLM summaries for older turns + full recent turns, shared with debate context manager
- ✅ **5.4 Panel Chat Mode** — `council chat <panel>` for multi-expert conversation with moderator-style turn taking
- ✅ **5.5 @Mention Support** — `@<expert-slug>` directs a turn at a specific panel member
- ✅ **5.6 Inline Structured Debate** — `@convene <topic>` inside chat triggers a 4-phase debate, then resumes chat
- ✅ **5.7 Chat Renderer** — Ink-based chat UI with streaming, expert color coding, and `@mention` highlighting

---

## Phase 6: Document Intelligence ✅

> Persona experts grounded in user-supplied documents, plus panel-level document folders for shared context. RAG retrieval during conversations.

- ✅ **6.1 Document Detection & Extraction** — Detect supported formats (md, txt, pdf, docx, and more — run `council docs formats`) under `docs/` and extract text
- ✅ **6.2 Persona Profile Analysis** — LLM-based profile synthesis from documents into the expert's persona section
- ✅ **6.3 Content Indexing (RAG)** — Chunk + index documents into SQLite FTS5 for BM25-ranked retrieval (`001_unified.sql`)
- ✅ **6.4 On-demand Processing** — Process documents lazily on first chat/debate use with visible progress feedback
- ⏳ **6.5 Background Processing** — **Deferred** — on-demand processing (6.4) covers the primary use case; a background daemon adds complexity with limited incremental value for a CLI tool
- ✅ **6.6 Expert Document CLI** — `council expert docs <slug>` lists indexed documents, `--remove <file>` un-indexes one, and `council expert train <slug>` reprocesses docs and refreshes the profile
- ✅ **6.7 Panel Document Folder** — `~/Council/panels/<panel>/docs/` with `panel docs link/unlink` for shared panel context (`001_unified.sql`)
- ✅ **6.8 Recency Weighting** — Newer documents weighted higher during retrieval to bias persona toward latest material

---

## Phase 7: Context & Awareness ✅

> Final polish — strict memory boundaries by expert kind, plus cross-panel awareness so experts know which other panels they participate in.

- ✅ **7.1 Memory Model Enforcement** — Generic experts get debate memory only; persona experts get document + debate memory; enforced in `prompt-builder`
- ✅ **7.2 Cross-Panel Awareness** — 1:1 chat surfaces a summary of the expert's other panels and recent cross-panel activity
- ✅ **7.3 Panel Membership Tracking** — `panel-membership-query` injects panel list and roles into prompts
- ✅ **7.4 Memory/Profile Separation** — `council memory reset` clears extracted debate memory but preserves persona profiles

---

## Phase 7.5: UX Polish ✅

> CLI refinement driven by a comprehensive 15-expert cross-model UX audit (106 findings, 20 PRs).

- ✅ **7.5.1 CLI Discoverability** — Help text grouping, usage examples, cross-references, doctor first-run hint
- ✅ **7.5.2 Accessibility** — NO_COLOR/TERM=dumb support, ASCII mode, expert index prefixes, bidi-override security fix, screen reader compatibility, Ink fallback chain
- ✅ **7.5.3 Renderer Quality** — Unified 8-color palette, Ink `<Static>` performance, Ctrl+C handler, error cap, loading spinner, round separators, dynamic width
- ✅ **7.5.4 Developer Experience** — Semantic exit codes, fuzzy-match suggestions, `council config` command, `--engine` default, first-run UX, `--quiet` flag, `--timeout` on conclude
- ✅ **7.5.5 Information Architecture** — Next-step hints, sessions enrichment, synthesis turn styling, conclude reorder, inspect JSON, edit backup/validation
- ✅ **7.5.6 Code Quality** — chat.ts split (87KB → 6 modules), Commander `.choices()` migration, flag help tiering

---

## Phase 7.6: PM-Driven QA Fixes ✅

> Bug fixes and UX improvements driven by a comprehensive PM persona testing session (45 findings, 28 fixed).

- ✅ **7.6.1 Context Isolation** — Fresh `convene` sessions no longer inherit memory from prior debates on the same panel; `resume` retains history as intended (T1)
- ✅ **7.6.2 Panel Lifecycle** — `council panel delete` subcommand with confirmation prompt, cascade cleanup, and empty-panel warnings on expert delete (T2)
- ✅ **7.6.3 CLI Discoverability (Round 2)** — Plural aliases (`panels`, `experts`, `history`), corrected error messages, template descriptions in `council templates` output (T3, T8)
- ✅ **7.6.4 Mock Engine Completeness** — `council conclude --engine mock` returns valid JSON synthesis responses (T4)
- ✅ **7.6.5 Per-Invocation Model Override** — `--model` flag on `convene` and `conclude` for model selection without config changes (T5)
- ✅ **7.6.6 Graceful Interrupt** — Ctrl+C during `convene` debates aborts gracefully with partial transcript saved (T6)
- ✅ **7.6.7 Export Completeness** — Prefix matching for session names and full multi-debate history in exports (T7)
- ✅ **7.6.8 Help Text Clarity** — Stance renamed to "viewpoint" with examples, quoting guidance for special characters, `--panel` alias for `--template` (T8, T9)
- ✅ **7.6.9 Document Ingestion UX** — `expert train --file` and `--url` flags for direct document ingestion during training (T10)

---

## Phase 8: Growth & Ecosystem ⬜

> Meet users where they are — GitHub, CI, and beyond Copilot.

- ⬜ **8.1 `gh` CLI Extension** — Install and run Council via `gh extension install`
- ⬜ **8.2 GitHub Action** — Automated deliberation in CI (e.g., architecture review on PR diff)
- ⬜ **8.3 Opt-in Telemetry** — Anonymous usage metrics, disabled by default
- ⬜ **8.4 Direct Provider APIs** — OpenAI/Anthropic adapters for users without Copilot

---

## Phase 9: Interactive TUI ("Council Console") 🚧

> **Goal**: Running bare `council` on a TTY opens a full-screen interactive terminal UI where a
> regular user can do everything — settings, panels, experts, training, chat, convene, sessions —
> without memorizing subcommands. The CLI stays unchanged for agents, scripts, and CI.
>
> **Status**: Current focus. Full design: [docs/designs/interactive-tui.md](./docs/designs/interactive-tui.md).
> Built milestone-by-milestone behind `COUNCIL_TUI=1`; released as a complete experience at 9.10.

- ✅ **9.1 Spike & De-risk** — Deps added (`react-router`, `ink-text-input`, `ink-select-input`, `ink-testing-library`); riskiest Ink primitives built + tested in isolation (ErrorBoundary, `useMode` nav/typing gate, windowed ScrollView, MultilineInput, command palette, non-TTY guard) in `packages/cli/src/tui/`; vendor/router smoke confirms compatibility under Ink 7 / React 19
- ✅ **9.2 App Shell & Navigation** — 3-zone alternate-screen layout (`AppShell`/`Header`/`Footer`), collapsible `LeftNav` (expanded / icon-rail / hidden + `\` toggle, adaptive by width), `MemoryRouter` routes, semantic color tokens + NO_COLOR, responsive breakpoints, contextual footer hints, `?` `HelpModal`, `Esc`/`q` quit, `HomeScreen` dashboard (counts + recent sessions), and the `CouncilTUI` root + `launchTui` entry gated behind `COUNCIL_TUI=1` (non-TTY → help) in `packages/cli/src/tui/`
- ✅ **9.3 Library Browse/Detail** — read-only Panels / Experts / Sessions list + detail screens, each backed by a unit-tested view-model adapter (`src/tui/adapters/*`); list→detail navigation with a centralized route-aware `Esc`; sessions show the honest persisted `debate.status` (Council does not persist conclusions); a `Ctrl-K` fuzzy command palette navigates between sections
- ✅ **9.4 Settings Overlay** — editable `SettingsScreen` (`/settings`) over a 100%-covered `config-settings` adapter: 18 scalar config fields across 8 sections with per-field validation mirroring the CLI's coercion (strict integer vs `Number()`), inline error display, dirty staging, and Ctrl+S Save via `updateConfigFields` (Zod schema as the final guard). A new input-capture context gates the app shell's global keys so form editing never double-dispatches
- ⬜ **9.5 Expert Authoring & Training** — Create generic + persona experts, edit, delete (with affected-panel warnings); add documents (path/URL), live indexing progress, list/remove, profile refresh
- ⬜ **9.6 Panel Authoring** — Create a panel from a multi-select of experts, edit members, delete; auto-compose from a topic with confirmation
- ⬜ **9.7 Chat (1:1 & Panel)** — Streaming chat with `@mention`, follow-scroll, thinking indicator, history/resume, inline `@convene`
- ⬜ **9.8 Convene & Conclude** — Cost-confirmation modal → live debate stream (expert pills, per-expert colors, round/phase markers, footer cost meter), `Esc` cancel (partial preserved); decision-matrix conclusion view
- ⬜ **9.9 Inspection, Memory, Export & A11y Polish** — Memory inspection in expert detail, export overlay, first-run onboarding, tiered error display, startup warnings, accessibility + responsive audit
- ⬜ **9.10 Make Default & Release** — Flip bare `council` on a TTY to launch the TUI (`--no-tui` / `COUNCIL_NO_TUI` escape; non-TTY fallback); add `council ui`; docs; smoke / platform / performance QA; opt-in TUI telemetry

---

## 1.0 Readiness ⬜

> Release-readiness criteria for a stable 1.0 launch.

- ⬜ **Privacy Policy** — Publish `PRIVACY.md` covering data handling, storage, and third-party provider behavior
- ⬜ **Windows/macOS CI** — Verify the CLI across supported desktop platforms
- ⬜ **Direct Provider Abstraction** — Add OpenAI/Anthropic provider support without requiring Copilot
- ⬜ **Stability, SemVer, and Deprecation Policy** — Define compatibility guarantees and migration expectations
- ⬜ **Supply-chain Baseline** — Establish CodeQL, Scorecard, and SBOM coverage

---

## Key Milestones

| Milestone                                              | Phase | Status                 |
| ------------------------------------------------------ | ----- | ---------------------- |
| `pnpm build && pnpm test` pass                         | 1     | ✅ Done                |
| `council convene "topic"` produces multi-expert debate | 1     | ✅ Done                |
| Structured 4-phase choreography                        | 2     | ✅ Done                |
| Individual expert chat                                 | 2     | ✅ Done                |
| Session resume + export + memory CLI                   | 3     | ✅ Done                |
| Human-as-expert participation                          | 3     | ✅ Done                |
| Panel auto-composition (no `--template` required)      | 2     | ✅ Done                |
| Experts remember across sessions                       | 3     | ✅ Done                |
| `council conclude` with decision matrix                | 2     | ✅ Done                |
| Rich Ink terminal UI                                   | 3     | ✅ Shipped             |
| Experts as standalone reusable entities                | 4     | ✅ Done                |
| Persistent 1:1 and panel chat                          | 5     | ✅ Done                |
| Document-driven persona experts                        | 6     | ✅ Done (6.5 deferred) |
| Cross-panel expert awareness                           | 7     | ✅ Done                |
| UX polish: 106 findings from cross-model audit         | 7.5   | ✅ Done                |
| PM-driven QA fixes (45 findings, 28 fixed)             | 7.6   | ✅ Done                |
| Published to npm as `@council-ai/cli`                  | 8     | ✅ Done (v0.3.0)       |
| Interactive TUI shell (`council` console)              | 9     | 🚧 In Progress         |
