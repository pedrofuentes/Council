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
- ✅ **3.2 Session Resume** — `council resume` for transcript replay and `--continue` for new debates
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
- ✅ **4.7 Schema Migration 004** — `expert_library`, `panel_library`, and `panel_members` tables (`004_expert_library.sql`)

---

## Phase 5: Conversational Experience ✅

> Persistent chat — both 1:1 with an expert and multi-expert panel chat — with smart context handling and inline structured debates.

- ✅ **5.1 Chat Session Infrastructure** — `ChatSession` model + `chat_sessions` / `chat_turns` tables (`005_chat.sql`)
- ✅ **5.2 1:1 Expert Chat** — `council chat <expert-slug>` for persistent single-expert conversation
- ✅ **5.3 Context Management** — Rolling LLM summaries for older turns + full recent turns, shared with debate context manager
- ✅ **5.4 Panel Chat Mode** — `council chat <panel>` for multi-expert conversation with moderator-style turn taking
- ✅ **5.5 @Mention Support** — `@<expert-slug>` directs a turn at a specific panel member
- ✅ **5.6 Inline Structured Debate** — `@convene <topic>` inside chat triggers a 4-phase debate, then resumes chat
- ✅ **5.7 Chat Renderer** — Ink-based chat UI with streaming, expert color coding, and `@mention` highlighting

---

## Phase 6: Document Intelligence ✅

> Persona experts grounded in user-supplied documents, plus panel-level document folders for shared context. RAG retrieval during conversations.

- ✅ **6.1 Document Detection & Extraction** — Detect supported formats (md, txt, pdf, docx) under `docs/` and extract text
- ✅ **6.2 Persona Profile Analysis** — LLM-based profile synthesis from documents into the expert's persona section
- ✅ **6.3 Content Indexing (RAG)** — Chunk + index documents into SQLite FTS5 for BM25-ranked retrieval (`007_document_index.sql`)
- ✅ **6.4 On-demand Processing** — Process documents lazily on first chat/debate use with visible progress feedback
- ⏳ **6.5 Background Processing** — **Deferred** — on-demand processing (6.4) covers the primary use case; a background daemon adds complexity with limited incremental value for a CLI tool
- ✅ **6.6 Expert Document CLI** — `council expert docs add | list | remove | reprocess`
- ✅ **6.7 Panel Document Folder** — `~/Council/panels/<panel>/docs/` with `panel docs link/unlink` for shared panel context (`009_panel_documents.sql`)
- ✅ **6.8 Recency Weighting** — Newer documents weighted higher during retrieval to bias persona toward latest material

---

## Phase 7: Context & Awareness ✅

> Final polish — strict memory boundaries by expert kind, plus cross-panel awareness so experts know which other panels they participate in.

- ✅ **7.1 Memory Model Enforcement** — Generic experts get debate memory only; persona experts get document + debate memory; enforced in `prompt-builder`
- ✅ **7.2 Cross-Panel Awareness** — 1:1 chat surfaces a summary of the expert's other panels and recent cross-panel activity
- ✅ **7.3 Panel Membership Tracking** — `panel-membership-query` injects panel list and roles into prompts
- ✅ **7.4 Memory/Profile Separation** — `council memory reset` clears extracted debate memory but preserves persona profiles

---

## Phase 8: Growth & Ecosystem ⬜

> Meet users where they are — GitHub, CI, and beyond Copilot.

- ⬜ **8.1 `gh` CLI Extension** — Install and run Council via `gh extension install`
- ⬜ **8.2 GitHub Action** — Automated deliberation in CI (e.g., architecture review on PR diff)
- ⬜ **8.3 Opt-in Telemetry** — Anonymous usage metrics, disabled by default
- ⬜ **8.4 Direct Provider APIs** — OpenAI/Anthropic adapters for users without Copilot

---

## Key Milestones

| Milestone                                              | Phase | Status                |
| ------------------------------------------------------ | ----- | --------------------- |
| `pnpm build && pnpm test` pass                         | 1     | ✅ Done               |
| `council convene "topic"` produces multi-expert debate | 1     | ✅ Done               |
| Structured 4-phase choreography                        | 2     | ✅ Done               |
| Individual expert chat                                 | 2     | ✅ Done               |
| Session resume + export + memory CLI                   | 3     | ✅ Done               |
| Human-as-expert participation                          | 3     | ✅ Done               |
| Panel auto-composition (no `--template` required)      | 2     | ✅ Done               |
| Experts remember across sessions                       | 3     | ✅ Done               |
| `council conclude` with decision matrix                | 2     | ✅ Done               |
| Rich Ink terminal UI                                   | 3     | ✅ Shipped            |
| Experts as standalone reusable entities                | 4     | ✅ Done               |
| Persistent 1:1 and panel chat                          | 5     | ✅ Done               |
| Document-driven persona experts                        | 6     | ✅ Done (6.5 deferred)|
| Cross-panel expert awareness                           | 7     | ✅ Done               |
| Published to npm as `@council/cli`                     | 8     | ⬜ Planned            |
