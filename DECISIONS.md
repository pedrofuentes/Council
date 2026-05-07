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
**Status**: Accepted (backend choice updated by ADR-005 on 2026-05-07: now `@libsql/client`, not `better-sqlite3`; the orchestration-index-only role is unchanged)
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

### ADR-005: SQLite backend = `@libsql/client` (pure WASM), not `better-sqlite3`
**Date**: 2026-05-07
**Status**: Accepted (supersedes the implicit `better-sqlite3` choice in DECISIONS ADR-002 and ROADMAP §1.7)
**Context**: ROADMAP §1.7 originally specified `better-sqlite3` + Kysely. During Phase 1 implementation (after PR #54 landed) the dev environment exposed a hard blocker: `better-sqlite3@11.10.0` ships no Node 25.5.0 prebuild, and the local Visual Studio Build Tools install lacks the ClangCL toolset required by `node-gyp`. Verified runtime failure: `Could not locate the bindings file. Tried [...] compiled\25.5.0\win32\x64\better_sqlite3.node`. This blocks ROADMAP §1.7, §1.8, §1.10, §1.12, §1.13 and most of Phases 2–3. Council's positioning ("simple to run") cannot survive a tool that requires users to install Visual Studio Build Tools.

**Decision**: Use `@libsql/client` (pure JavaScript / WebAssembly, by Turso) as the SQLite backend, paired with `@libsql/kysely-libsql` as the Kysely dialect. Local file mode via `url: 'file:./db.sqlite'`; `:memory:` mode via `url: ':memory:'` for tests. No native build, no toolchain, no prebuilds.

**Alternatives considered**:
- **`node:sqlite` (built-in)** — appealing long-term but still Release Candidate in Node 24 LTS as of mid-2026; requires `--experimental-sqlite` flag; would force end users to set Node flags. Re-evaluate when stable.
- **`node-sqlite3-wasm`** — pure WASM, sync API, but smaller community and no first-party Kysely dialect (would force a custom one).
- **Stay with `better-sqlite3`** — only viable if every contributor and user installs Visual Studio Build Tools. Violates "simple to run".

**Consequences**:
- ✅ `pnpm install` works on every Node version forever, on any OS, with no toolchain prerequisites.
- ✅ Strategic alignment with Council Cloud (Phase 5): same code path moves from `file:` URL to `libsql://...` URL when we ship hosted persistence; no rewrite.
- ✅ Async API matches the rest of Council's codebase (`AsyncIterable`, `Promise`-based engine).
- ⚠️ WASM is slower than native C++ for very high query throughput. Council's workload (orchestration metadata: panels, experts, debates, turns) is well below any threshold where this matters.
- ⚠️ Some niche SQLite extensions may not be in the WASM build; revisit only if a future feature needs one.
- 📝 ROADMAP §1.7 spec updated to reference libsql syntax. AGENTS.md tech-stack line still mentions `better-sqlite3`; informational only and HUMAN REQUIRED to edit — package.json is the real source of truth.
