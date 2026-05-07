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

### ADR-001: Use @github/copilot-sdk as primary AI engine
**Date**: 2026-05-06
**Status**: Accepted
**Context**: Council needs multi-model AI access (GPT, Claude, Gemini) for expert panels. Options were: direct provider APIs (OpenAI, Anthropic, Google separately), Vercel AI SDK (unified wrapper), or GitHub Copilot SDK.
**Decision**: Use `@github/copilot-sdk` as the primary engine, behind a `CouncilEngine` abstraction interface.
**Alternatives considered**: Vercel AI SDK (good unified interface but requires separate API keys per provider), direct provider APIs (maximum control but complex key management and billing).
**Consequences**: Zero API key setup for users with Copilot subscription. Locked to Copilot's model availability and rate limits. SDK is in public preview and may break. Mitigated by `CouncilEngine` interface that allows swapping engines. Direct provider adapters planned for Phase 4.

### ADR-002: SQLite as orchestration index, not transcript store
**Date**: 2026-05-06
**Status**: Accepted
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
