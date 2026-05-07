# Roadmap — Council

> Project phases, milestones, and implementation plan.

## Current Phase

**Phase 1: Foundation** — Setting up the project scaffolding, CouncilEngine interface, Copilot SDK adapter, expert system, basic debate orchestrator, and core CLI commands. Goal: `council convene "topic"` produces a useful multi-expert discussion.

## Phases

### Phase 1: Foundation (13 items)
- Project scaffolding (pnpm, TypeScript ESM, tsup, Vitest)
- CouncilEngine interface — the architectural seam
- MockEngine for deterministic testing
- Copilot SDK adapter (one client, N sessions, denyAll)
- Configuration system (YAML, Zod validation)
- Expert system (8-section prompt template, anti-sycophancy)
- SQLite schema (panels, experts, debates, turns with ULIDs)
- Basic debate orchestrator (AsyncIterable<DebateEvent>)
- Pluggable renderers (Ink / JSON / Plain)
- Core CLI commands (convene, ask, panels, resume, doctor)
- 5 built-in panel templates
- `council doctor` diagnostics command
- Cost estimation system

### Phase 2: Deliberation Quality (7 items)
- Individual expert chat (council ask --expert)
- Structured debate engine (Opening → Cross-exam → Rebuttal → Synthesis)
- Pluggable moderator strategies
- Anti-sycophancy enforcement (3-layer system)
- Panel auto-composition
- Context window management
- `council conclude` — decision matrix output

### Phase 3: Persistence & Polish (7 items)
- Persistent expert memory
- Session resume
- Human-as-expert participation
- Rich Ink terminal UI
- Memory inspection CLI
- Export system (Markdown, JSON, Decision Record)
- Error resilience

### Phase 4: Growth & Ecosystem (4 items)
- `gh` CLI extension
- GitHub Action for automated PR review
- Opt-in telemetry
- Direct provider APIs (BYO-key for non-Copilot users)

## Key Milestones

| Milestone | Phase | Status |
|-----------|-------|--------|
| `council convene` produces multi-expert discussion | Phase 1 | pending |
| Individual expert chat works | Phase 2 | pending |
| Structured debate with synthesis | Phase 2 | pending |
| Experts remember across sessions | Phase 3 | pending |
| Published to npm | Phase 4 | pending |
| Show HN launch | Phase 4 | pending |
