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

### [2026-05-12] Persona profile analysis — multi-cycle sanitisation hardening, TOCTOU-safe extraction, layered prompt-injection defenses
**Context**: Roadmap 6.2 + 6.4 + 6.8 (persona profile analysis, on-demand document processing, recency weighting). Across PRs #357, #373, #375 and follow-up Sentinel cycles, the persona-profile pipeline went through several rounds of hardening before landing.
**Learning**:
1. **Single-layer sanitisation has bypasses; stack escapes deliberately.** First-pass code applied only the per-`<` fence escape; a Sentinel finding showed that `[N]` markers in `existingProfile` fields could still spoof section headers in the privileged system prompt. The fix layered `sanitizePromptField` (C0 strip + line-break collapse + `[N]` defang + length cap) on top of the per-character escape. **Rule of thumb**: every interpolated, externally-sourced field in a privileged prompt needs *both* a structural sanitiser AND a context-specific escape (e.g. `<` → `&lt;` for fenced data).
2. **Unicode line breaks are not just CR/LF.** `\n`, `\r`, NEL (U+0085), LS (U+2028), PS (U+2029), and `\v` / `\f` all break the "single line" assumption that `[N]`-marker defanging relies on. Test payloads must include the full set; otherwise an attacker can smuggle a fake section header on its own line.
3. **TOCTOU-safe file reads need the full open → fd-stat → realpath → lstat-compare → confinement-check → fd-read sequence.** Validating `realpath` then reading by path is racy — an attacker can swap the symlink between calls. Both `extractor.ts` and `detector.ts` had to migrate to `fs.open` first and read via the bound `FileHandle`. Mtime must also come from `fh.stat()` (not a post-open `fs.stat(path)`) or it can describe a different inode than the one whose bytes were read (#376).
4. **Freeze the canonical confinement root once.** Re-`realpath()`ing the root for every file inside the loop opens a root-swap window. Resolve once at processor entry, pass the canonical root + `_rootIsCanonical: true` through to every per-file extractor call.
5. **LLM extraction needs bounded retry and `finally`-tear-down.** A single retry on malformed JSON catches transient streaming truncation without exploding cost; persistent failure throws a fixed-message `Error("Profile analyzer returned unparsable JSON after retry")` (no raw response embedded). "Malformed" is permissive: strip a leading ```` ```json ```` / ```` ``` ```` code fence, then `JSON.parse`; treat as malformed only if parse throws OR the required narrative fields (`communicationStyle`, `epistemicStance`) are missing/empty. The transient analyzer expert MUST be removed in `finally`; cleanup failures must surface as warnings, not mask the underlying analysis result.
**Recency weighting is a prompt-side annotation, not an input ordering or retrieval score (so far).** Roadmap 6.8 ships as `[Weight: 0.NN]` tags emitted on each document block in the analyzer meta-prompt; `analyzeDocuments()` preserves the caller's input order — it does NOT sort by `modifiedAt`. The LLM weights documents qualitatively in response to the tag values and an explicit prompt instruction. Retriever ranking is unchanged. `halfLifeDays <= 0` clamps every weight to 1.0 (never zeros every doc); future-dated `modifiedAt` clamps to 1.0 (never amplifies).
**Impact**: When adding any new code path that interpolates externally-sourced data into a privileged prompt, **always** route through `sanitizePromptField` AND apply the context-specific escape. When opening user-controlled files, use the fd-bound sequence in `extractor.ts` as the canonical pattern. When adding new format normalisers, keep them in regex form (per ADR-009) — do not reach for a parser dependency.

### [2026-05-12] libsql `:memory:` mode does not survive `db.transaction()` — drops FTS5 virtual tables on reconnect
**Context**: Implementing atomic `council memory reset` (#403) revealed that wrapping work in Kysely's `db.transaction()` against an `@libsql/client` `url: ':memory:'` connection silently reconnects under the hood. The reconnect spins up a fresh in-memory database — every previously-created FTS5 virtual table (and the schema_version row, and every test-seeded panel) is gone. Tests that worked against a file-mode DB failed against `:memory:` with "no such table: document_index".
**Learning**:
1. **`:memory:` is per-connection, not per-process.** This is standard SQLite behaviour, but it interacts surprisingly with Kysely's `db.transaction()` in libsql, which acquires a fresh client and therefore a fresh in-memory DB.
2. **The fix is application-level transaction control on the libsql connection directly.** Use `BEGIN` / `COMMIT` / `ROLLBACK` issued through `db.executeQuery()` (or the libsql client method) rather than Kysely's `db.transaction(async (trx) => …)` wrapper, so the same connection (and the same in-memory state) participates throughout.
3. **The convention is documented in real code paths.** See `document-repository.clearForRetrain` and the documents indexer for the same pattern. New atomic sequences should follow that convention rather than reaching for `db.transaction()`.
4. **File-mode tests would not have caught this.** Anything that exercises FTS5 virtual tables under transactions MUST run against `:memory:` in CI to prevent regressing on this.
**Impact**: Sets a project-wide rule: **do not use `db.transaction()` from Kysely when the test suite or runtime may be on `:memory:` libsql, or when FTS5 virtual tables / `schema_version` must persist across the transaction**. Use raw `BEGIN` / `COMMIT` / `ROLLBACK` on the libsql connection. Document this in the JSDoc of any new repository method that needs atomicity.

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
