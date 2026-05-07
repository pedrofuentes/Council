# Learnings — Council

> **This file is written by AI agents.** When you discover something about this project
> that isn't documented elsewhere, add it here. Do NOT write to AGENTS.md.
>
> Periodically, a human or agent should review this file and promote stable learnings
> into the appropriate companion doc (ARCHITECTURE.md, TESTING-STRATEGY.md, etc.).

## Format

```markdown
### [YYYY-MM-DD] Short description
**Context**: What were you doing when you discovered this?
**Learning**: What did you learn?
**Impact**: How should this affect future work?
```

## Learnings

<!-- Add new learnings below this line, most recent first -->

### [2026-05-06] Copilot SDK bundles ~187MB unpacked
**Context**: Architecture analysis during project planning.
**Learning**: `@github/copilot-sdk` bundles the full `@github/copilot` package (~187MB). This rules out binary distribution (pkg/nexe) and means `npm install -g` is a 200+ MB download.
**Impact**: Primary distribution must be `npm install -g @council/cli`. Consider `npx` for try-before-install, but note cold-run UX. Don't pursue binary packaging.

### [2026-05-06] SDK's infiniteSessions provides free context compaction
**Context**: Analyzing context window management strategies.
**Learning**: The Copilot SDK has a built-in `infiniteSessions` option that automatically compacts context when it grows too large. This eliminates the need to build custom context compaction in v0.
**Impact**: Enable `infiniteSessions: { enabled: true }` on all expert sessions. Only build custom context management if this proves inadequate.

### [2026-05-06] One CopilotClient, N sessions — not N clients
**Context**: Designing expert session architecture.
**Learning**: The SDK multiplexes sessions over a single JSON-RPC channel. Spawning N CLI subprocesses (one per expert) is wasteful. One client handles all expert sessions.
**Impact**: Use `ExpertSessionPool` pattern — one `CopilotClient.start()` per debate, acquire sessions per expert via `createSession()`.
