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

### [2026-05-07] better-sqlite3 has no Node 25.5 prebuild — switched to @libsql/client (pure WASM)
**Context**: Phase 1.7 (sqlite-schema) was about to start when a fresh `pnpm install` of `better-sqlite3@11.10.0` failed on the dev machine: prebuilds for Node 25.5.0 don't exist yet, and the local Visual Studio Build Tools install lacks the ClangCL toolset that `node-gyp` needs to compile from source. Verified runtime error: `Could not locate the bindings file. Tried [...] compiled\25.5.0\win32\x64\better_sqlite3.node`. This blocked the entire SQLite track of the roadmap.
**Learning**:
1. **Never depend on a native module's prebuild availability for a "simple to run" CLI tool.** The window between a Node release and a native package's prebuild being published is exactly when new contributors hit the wall.
2. **Pure WASM SQLite (libsql) is now production-grade.** `@libsql/client` runs SQLite via WebAssembly with file persistence, an official Kysely dialect (`@libsql/kysely-libsql`), and the same SQL surface. Slower than native C++ for high-throughput workloads but invisible for orchestration metadata.
3. **`node:sqlite` is not yet the answer.** Still Release Candidate in Node 24 LTS as of mid-2026, requires `--experimental-sqlite` flag. Re-evaluate when stable.
**Impact**: Council uses `@libsql/client` + `@libsql/kysely-libsql` from PR onward. Bonus: future Council Cloud (Phase 5) can move from `url: 'file:./db.sqlite'` to `url: 'libsql://...'` with no code change. See ADR-005.

### [2026-05-06] Native deps deferred from scaffolding PR due to Node 25.5.0 prebuild gap
**Context**: Phase 1.1 scaffolding (`chore/scaffold` PR #1). Initial `pnpm install` failed because `better-sqlite3@11.10.0` had no prebuilt binary for Node 25.5.0 and the local Visual Studio Build Tools lacked the ClangCL toolset required for `node-gyp` rebuild.
**Learning**: On Node releases that ship before native-module maintainers cut prebuilds, fresh `pnpm install` will fall back to `node-gyp` and require a working C/C++ toolchain. ROADMAP §1.1 listed `@github/copilot-sdk` (~187MB), `better-sqlite3`, `ink`, `react`, `kysely`, `zod`, `yaml`, `ulid`, `chalk`, `pino` as scaffolding dependencies, but only `commander` is exercised by the scaffolding acceptance criteria.
**Impact**: Each remaining Phase 1 dep should be added in the PR that first uses it:
  - `zod`, `yaml` → Phase 1.5 (Configuration system)
  - `@github/copilot-sdk` → Phase 1.4 (Copilot SDK adapter)
  - `better-sqlite3`, `kysely`, `ulid` → Phase 1.7 (SQLite schema)
  - `ink`, `ink-spinner`, `react`, `chalk`, `pino` → Phase 1.9 / 3.4 (renderers / Ink UI)
  Adding deps incrementally also gives Sentinel a focused diff to review per PR.

### [2026-05-06] tsup applies `banner` globally — use array config to scope per entry
**Context**: Sentinel REJECTED PR #1 because `dist/index.js` (library entry) shipped with a `#!/usr/bin/env node` shebang inherited from the global `banner` option intended only for the `bin/council.js` entry. The `esbuildOptions` hook does NOT receive per-entry context that would let us strip the banner conditionally.
**Learning**: `tsup` does not support per-entry `banner` in a single config object. The clean fix is `defineConfig([cfg1, cfg2])` — an array of independent build configurations sharing `outDir`. The second entry must set `clean: false` so it does not wipe the first entry's output.
**Impact**: Use the array-config pattern any time entries need divergent banner / format / target / external settings.

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
