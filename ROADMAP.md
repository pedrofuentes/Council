# Roadmap — Council

> High-level project roadmap. For implementation details, file references, and acceptance criteria, see [ROADMAP-Detailed.md](./ROADMAP-Detailed.md).

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

## Phase 2: Deliberation Quality 🚧

> Deeper, more useful debates through structured modes, smarter moderation, and context management.

- ✅ **2.1 Individual Expert Chat** — `council ask` for one-shot single-expert queries
- ✅ **2.2 Structured Debate Engine** — 4-phase choreography (opening → cross-exam → rebuttal → synthesis)
- ✅ **2.3 Pluggable Moderator Strategies** — `ModeratorStrategy` interface with 5 built-in strategies (not yet wired into orchestrator — see [#212](https://github.com/pedrofuentes/Council/issues/212))
- ✅ **2.4 Anti-sycophancy Enforcement** — 3-layer quality gate (forbidden phrases, disagreement budget, specificity)
- ⬜ **2.5 Panel Auto-composition** — LLM meta-prompt generates expert panels from topic analysis
- ⬜ **2.6 Context Window Management** — Visibility scoping, rolling summaries, per-expert token budgets
- ⬜ **2.7 `council conclude` Command** — Decision matrix with consensus, tensions, and recommendation

---

## Phase 3: Persistence & Polish 🚧

> Experts remember, sessions persist, and the UX is polished.

- 🚧 **3.1 Persistent Expert Memory** — Foundation shipped (DB + prompt placeholder); recall logic remaining
- ✅ **3.2 Session Resume** — `council resume` for transcript replay and `--continue` for new debates
- ✅ **3.3 Human-as-expert** — `council convene --human` adds interactive human participants
- ⬜ **3.4 Rich Ink Terminal UI** — React + Ink components with color-coded experts and streaming text
- ✅ **3.5 Memory Inspection CLI** — `council memory list/inspect/reset` for panel/expert curation
- ✅ **3.6 Export System** — `council export` in markdown, JSON (NDJSON), and ADR formats
- ✅ **3.7 Error Resilience** — Retry with backoff, actionable error messages, graceful degradation

---

## Phase 4: Growth & Ecosystem ⬜

> Meet users where they are — GitHub, CI, and beyond Copilot.

- ⬜ **4.1 `gh` CLI Extension** — Install and run Council via `gh extension install`
- ⬜ **4.2 GitHub Action** — Automated deliberation in CI (e.g., architecture review on PR diff)
- ⬜ **4.3 Opt-in Telemetry** — Anonymous usage metrics, disabled by default
- ⬜ **4.4 Direct Provider APIs** — OpenAI/Anthropic adapters for users without Copilot

---

## Key Milestones

| Milestone | Status |
|-----------|--------|
| `pnpm build && pnpm test` pass | ✅ Done |
| `council convene "topic"` produces multi-expert debate | ✅ Done |
| Structured 4-phase choreography | ✅ Done |
| Individual expert chat | ✅ Done |
| Session resume + export + memory CLI | ✅ Done |
| Human-as-expert participation | ✅ Done |
| Experts remember across sessions | 🚧 Foundation shipped |
| `council conclude` with decision matrix | ⬜ Planned |
| Rich Ink terminal UI | ⬜ Planned |
| Published to npm as `@council/cli` | ⬜ Planned |
