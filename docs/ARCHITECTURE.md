# Architecture

> Extended architectural context for AI agents. Referenced from AGENTS.md.

---

## Project Structure

```
council/
├── src/
│   ├── bin/
│   │   └── council.ts                 ← CLI entry point, argv parsing, renderer selection
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── panel/                 ← panel create|list|show|delete
│   │   │   ├── debate/                ← debate start|resume|export
│   │   │   ├── expert/                ← expert add|remove|list
│   │   │   └── config/               ← config get|set
│   │   └── renderers/
│   │       ├── ink/                   ← Rich TUI components (TTY)
│   │       ├── json.ts               ← NDJSON output (CI/scripts)
│   │       └── plain.ts              ← Plain text fallback (non-TTY)
│   ├── core/
│   │   ├── panel.ts                   ← Panel aggregate (creation, lifecycle)
│   │   ├── expert.ts                  ← Expert entity (identity, prompt generation)
│   │   ├── debate.ts                  ← Debate orchestrator (AsyncIterable<DebateEvent>)
│   │   ├── moderator/
│   │   │   ├── index.ts               ← ModeratorStrategy interface
│   │   │   └── strategies/            ← round-robin, sequential, socratic, devil's-advocate
│   │   ├── transcript.ts              ← Immutable turn log
│   │   └── cost.ts                    ← Cost estimation & enforcement
│   ├── core/documents/                ← Document Intelligence (Roadmap 6.x)
│   │   ├── detector.ts                ← Walks expert/panel docs folder, SHA-256 change detection,
│   │   │                                fd-based confinement (TOCTOU-safe)
│   │   ├── extractor.ts               ← Format-aware content normalisation (Markdown/HTML/text)
│   │   │                                via regex normalisers; fd-bound reads with realpath/inode
│   │   │                                comparison against `confinementRoot` (per ADR-007)
│   │   ├── indexer.ts                 ← Writes extracted text into FTS5 `document_index`
│   │   ├── retriever.ts               ← Sanitised FTS5 query → ranked snippets for RAG
│   │   ├── processor.ts               ← End-to-end per-expert pipeline (detect → extract →
│   │   │                                index → analyze) wired into `council chat <persona>`
│   │   ├── profile-analyzer.ts        ← LLM-backed persona-profile distillation with
│   │   │                                recency-weight tagging (Roadmap 6.2 + 6.8); see ADR-008
│   │   └── panel-document-scanner.ts  ← Managed + linked folder scan for panel docs (6.7)
│   ├── engine/
│   │   ├── index.ts                   ← CouncilEngine interface (THE architectural seam)
│   │   ├── copilot/
│   │   │   ├── adapter.ts             ← ONLY file importing @github/copilot-sdk
│   │   │   ├── session-pool.ts        ← One client, N sessions, keyed by expert ID
│   │   │   └── permissions.ts         ← denyAll, scopedAllow
│   │   └── mock/
│   │       └── mock-engine.ts         ← Deterministic responses for testing
│   ├── memory/
│   │   ├── db.ts                      ← @libsql/client (WASM) + Kysely (per ADR-005)
│   │   ├── repositories/
│   │   │   ├── panels.ts
│   │   │   ├── experts.ts
│   │   │   └── turns.ts
│   │   └── migrations/                ← SQL migration files
│   ├── config/
│   │   ├── schema.ts                  ← Zod schemas for panel YAML, config YAML
│   │   └── loader.ts                  ← Config file discovery and loading
│   ├── telemetry/
│   │   └── logger.ts                  ← pino, file sink
│   ├── errors.ts                      ← Error types
│   └── index.ts                       ← Programmatic API
├── panels/                            ← Built-in panel YAML definitions
│   ├── architecture-review.yaml
│   ├── startup-validation.yaml
│   ├── code-review.yaml
│   ├── incident-postmortem.yaml
│   └── career-coaching.yaml
├── tests/
│   ├── unit/
│   └── integration/
├── docs/                              ← Agent and architecture documentation
├── AGENTS.md                          ← Agent instructions (MUST rules)
├── DECISIONS.md                       ← Architecture Decision Records
├── LEARNINGS.md                       ← Discovered knowledge
├── ROADMAP.md                         ← Project phases and plan
├── CHANGELOG.md                       ← User-facing changes
├── LICENSE                            ← MIT
├── README.md
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── vitest.config.ts
```

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| AI engine | `@github/copilot-sdk` behind `CouncilEngine` interface | Zero API key setup, multi-model access, single auth. Interface allows engine swap. |
| CLI framework | Commander.js + Ink | Commander for parsing, Ink for rich TUI. Pluggable renderers for JSON/Plain output. |
| Persistence | `@libsql/client` (WASM) + Kysely | Pure JS, no native build, future Turso-cloud-ready. Per ADR-005. |
| Bundler | tsup (esbuild) | Zero config, fast, dual ESM/CJS. |
| Testing | Vitest + MockEngine | Fast, ESM-native. MockEngine provides deterministic responses. |
| IDs | ULIDs | Lexicographic sort by creation time. Better than UUIDs for debugging. |
| Module system | ESM only | Node 20+ floor. All deps are ESM-first. |
| Permissions | denyAll by default | Experts are reasoners, not agents. Opt-in tool access per expert. |

## Module Boundaries

- `engine/` — Abstracts AI provider. Only `engine/copilot/adapter.ts` imports `@github/copilot-sdk`. Everything else uses `CouncilEngine` interface from `engine/index.ts`.
- `core/` — Domain logic. No SDK imports. Depends on `engine/` interface only.
- `cli/` — User interface layer. Consumes `core/` and renders via `renderers/`.
- `memory/` — Persistence. SQLite schema, repositories, migrations. Orchestration index only (SDK owns transcripts).
- `config/` — Configuration loading and validation. Zod schemas.

## Data Flow

```
User input → CLI command → Core (Panel/Debate/Moderator) → Engine (CouncilEngine)
                                      ↓                              ↓
                              Memory (SQLite)              Copilot SDK (AI models)
                                      ↓                              ↓
                              Renderer (Ink/JSON/Plain) ← DebateEvent stream
```

## Key Files

| File | Purpose |
|------|---------|
| `src/engine/index.ts` | CouncilEngine interface — the architectural seam |
| `src/engine/copilot/adapter.ts` | Only file importing @github/copilot-sdk |
| `src/core/debate.ts` | Debate orchestrator, AsyncIterable<DebateEvent> |
| `src/core/moderator/index.ts` | ModeratorStrategy interface |
| `src/core/expert.ts` | Expert entity, 8-section prompt template |
| `src/memory/db.ts` | libsql client (WASM) + Kysely connection, migrations, schema_version tracking |
| `panels/*.yaml` | Built-in panel definitions (Zod-validated) |

## Code Patterns

### Good: Named exports, explicit return types, readonly
```typescript
// ✅ Good
export interface ExpertSpec {
  readonly id: string;
  readonly slug: string;
  readonly model: string;
  readonly systemMessage: string;
}

export function createExpertPrompt(spec: ExpertSpec, memory: ExpertMemory): string {
  // ...
}
```

### Bad: Default exports, any types, mutable
```typescript
// ❌ Bad
export default class Expert {
  id: any;
  prompt: any;
}
```
