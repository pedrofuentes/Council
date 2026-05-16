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

### ADR-012: Layered prompt injection defense (zero external dependencies)
**Date**: 2026-05-14
**Status**: Accepted
**Context**: Council's multi-agent architecture creates an unusually wide prompt-injection surface compared to a single-agent chat tool. Cross-expert turns, LLM-composed panel definitions, persisted rolling summaries, RAG document snippets, persona profiles distilled from user-supplied documents, and `extracted_memory_json` rows all carry untrusted text that ends up interpolated into a privileged system prompt for the *next* expert. A successful injection in one expert's output can therefore propagate to another expert in the same panel, to a future chat turn (via summary or memory), or to a different panel altogether (via the cross-panel-awareness `[PANEL MEMBERSHIPS]` section). The defense must be present at every untrusted-data surface, must not rely on a single sanitiser working perfectly, and — critically for a zero-setup CLI — must not require a network API key, an ONNX runtime, or a 100MB+ classifier download to be functional out of the box.

**Decision**: Adopt a **5-layer in-process defense** with **zero new dependencies**:
1. **Structural sanitisation** — `sanitizePromptField` / `sanitizePromptBlock` / `sanitizeFenced` / `escapeFenceContent` in `src/core/prompt-sanitize.ts`. NFKC-normalises the input first so compatibility/fullwidth forms (e.g. `Ａ` → `A`, `［１］` → `[1]`) cannot bypass downstream pattern matching, then strips C0 controls (except `\t`/`\n`/`\r`) and DEL, strips bidi/zero-width characters, collapses Unicode line separators (NEL / U+2028 / U+2029), defangs `[N]` section markers, caps length. (C1 controls U+0080–U+009F are stripped separately by the chat renderer where terminal-side reinterpretation is the threat.) Field variant collapses newlines (for system-prompt fields); block variant preserves them (for fenced bodies).
2. **Heuristic detection** — `detectInstructionPatterns` in the same module returns matched suspicious-pattern names for telemetry/canary-triage. Does not hard-block (false-positive cost too high).
3. **Fencing & spotlighting** — untrusted content is wrapped in XML-style fences (`<from_expert>`, `<summary>`, `<transcript>`, `<<<DOC>>>`) with paired preambles instructing the model to treat fenced regions as evidence, not instructions. Fence attributes are escaped against both tag-break (`<`) and attribute-break (`"`).
4. **Schema enforcement** — `ExpertDefinitionSchema`'s Zod `superRefine` rejects `[NN]` section markers in string fields at parse time, so malicious YAML cannot even load.
5. **Canary tokens** — `src/core/canary.ts` injects a random opaque token into the system prompt and scans every expert response. A leak is a strong prompt-injection signal surfaced to the user as a warning.

All five layers are sync, in-process, and execute in under 1ms per call.

**Alternatives considered**:
- **External ML classifier (Lakera Guard, hosted)** — high-quality detection, but requires a network round-trip per turn, an API key in every user's install, and shipping every expert turn to a third party. Conflicts with the zero-setup CLI promise and the privacy posture of a local-first tool.
- **Local ONNX classifier (Microsoft Prompt Guard 2)** — no network, but adds ~100MB of model weights, an `onnxruntime` native dependency (re-introduces the `better-sqlite3`-style prebuild risk that ADR-005 was specifically designed to avoid), and ~50–200ms inference latency per check. Out of proportion to the threat model for a CLI deliberation tool.
- **Heuristic regex blocking only (no sanitisation, no fencing)** — trivial to bypass with Unicode homoglyphs, zero-width spaces, or split tokens. Single-layer defenses are by definition not defense-in-depth.
- **Trust the LLM to ignore injection attempts** — modern instruction-tuned models are partially robust, but the academic and red-team literature (Greshake et al.; Willison's prompt-injection series; the OWASP LLM Top 10) is unambiguous that this is not a defense.

External ML classifiers are **deferred to Phase 4** as an optional layer if the heuristic and canary signals prove insufficient in practice. The architectural seam to add one is straightforward: a single `IPromptInspector` interface in front of the heuristic detector.

**Consequences**:
- ✅ Zero new dependencies. No API key, no ONNX runtime, no model download — the defense works on `npm install -g` with nothing else configured.
- ✅ All defense is sync and sub-millisecond. No per-turn latency budget consumed by injection screening.
- ✅ Local-first / privacy posture preserved — no expert content is shipped to a third party for screening.
- ✅ Layered: a bypass of one layer (e.g. a novel Unicode sequence that survives sanitisation) is still caught by fencing, schema rejection, or canary detection.
- ⚠️ No ML-based semantic classification. Sophisticated obfuscated attacks that survive heuristic detection will only be caught at fence/canary boundaries, not pre-flagged.
- ⚠️ Heuristic and canary detection are *signals*, not blocks — surfaced as warnings, not enforced rejections. Adding a hard-block mode is a future decision tied to deployment context (CI vs. interactive).
- 📝 Test coverage in `tests/security/` (30 deterministic red-team payloads) is the ratchet — coverage of injection categories must not decrease, and new bypasses discovered in the wild land as new hardcoded tests cited by issue/PR.
- 📝 When adding a new untrusted-data surface (new RAG source, new cross-expert relay, new LLM-distilled field), the author MUST identify which of the five layers apply and wire them in before the surface ships. Sentinel verifies this on the introducing PR.

### ADR-011: User data directory split— `~/Council/` (visible) vs `~/.council/` (hidden)
**Date**: 2026-05-12
**Status**: Accepted
**Context**: Council writes two very different kinds of state to the user's home directory: (a) **author-facing artifacts** — expert YAMLs, panel YAMLs, persona document folders that users are expected to open in an editor, drag documents into, and version-control if they choose; and (b) **internal state** — the libsql database file, the resolved config, FTS indexes, generated profiles. Putting both in a single hidden `~/.council/` (the "Unix dotfile" default) hides the author-facing files from normal file-browser navigation, drag-and-drop, and `~/Documents`-style discovery; putting both in a visible `~/Council/` clutters the user's home with internal binaries (`council.db`, FTS shadow files) that they should not be editing.

**Decision**: Split user data across two directories on a single rule — **author-facing → visible, machine-managed → hidden**:
- `~/Council/` (visible, capitalised like `~/Documents`) holds expert YAMLs (`experts/<slug>.yaml`), panel YAMLs (`panels/<name>.yaml`), persona document folders (`experts/<slug>/docs/`), and panel document folders (`panels/<name>/docs/`). Resolved via `getCouncilDataHome(config?)` in `src/config/loader.ts`, which honours the `COUNCIL_DATA_HOME` env var (and the `paths.dataHome` config key) for tests and ephemeral mode. Users can open, edit, version-control, and drag files in/out freely; the document scanners detect changes via SHA-256 on the next `council chat`.
- `~/.council/` (hidden) holds `config.yaml` and `council.db` (and any future FTS shadow files / lock files / caches). Resolved via `getCouncilHome()` in `src/config/loader.ts`, which honours `COUNCIL_HOME`. Users have no business editing these directly.

The two env vars (`COUNCIL_HOME` and `COUNCIL_DATA_HOME`) are independent so tests can isolate the hidden state, the visible library, or both.

**Alternatives considered**:
- **Single `~/.council/` for everything.** Familiar Unix convention, single env var, but defeats the entire premise of "drop documents in to teach an expert" — users cannot see the docs folder in Finder/Explorer without enabling hidden files, and drag-and-drop is awkward.
- **Single `~/Council/` for everything.** Discoverable, but pollutes the user's home with `council.db` and internal state they shouldn't touch; risks accidental deletion of the DB while "cleaning up".
- **`~/Documents/Council/` for visible, `~/.config/council/` for hidden** (XDG-style). Closer to convention on Linux, but `~/Documents/` paths are localised on Windows and macOS (e.g. `~/Documenti/`), and `~/.config/` is non-idiomatic on Windows. Capitalised `~/Council/` is short, cross-platform, and matches the brand.

**Consequences**:
- ✅ Users can teach a persona expert by dragging documents into a folder they can actually find.
- ✅ Internal state stays out of the way; accidental `rm -rf ~/Council/` does not destroy the DB or config.
- ✅ Backup/version-control story is clear: `~/Council/` is safe to commit (or to `rsync` to another machine); `~/.council/` is not portable (libsql DB, schema-versioned).
- ⚠️ Two roots is one more concept than one root. Mitigated by: every CLI command resolves both paths via the same helpers (`getCouncilHome()` / `getCouncilDataHome()`), and `council doctor` prints both paths so users can find them.
- 📝 If a third category emerges (e.g. exported transcripts, telemetry) it lands under whichever root matches the same rule — author-facing → visible, machine-managed → hidden.

### ADR-010: Chat session model — separate `chat_sessions` / `chat_turns` tables, atomic seq allocation
**Date**: 2026-05-11
**Status**: Accepted
**Context**: Roadmap 5.x introduces persistent conversational chat (`council chat <expert>` and `council chat <panel>`) alongside the existing structured-debate machinery. Chat and debate share superficial structure (a sequence of speaker turns), so the obvious move is to reuse `debates` + `turns` with a new `kind` discriminator. On closer inspection the lifecycles diverge sharply: a debate is **bounded** (one prompt, fixed phases, terminal `status`, cost-estimated up front, persisted moderator strategy), while a chat is **open-ended and resumable** (no terminal phase, indefinite turn count, archive-don't-delete semantics, no moderator). Reusing `debates`/`turns` would force every column to be nullable for the side it doesn't apply to, dilute the meaning of `status`, and complicate the queries that already drive `council resume` / `council export`. A separate concern: every per-turn write needs a monotonic `seq` per session for replay ordering, and the chat REPL is the first code path where two turns can race (user types ahead while the engine is still streaming).

**Decision**:
- **Two new tables** in migration 005:
  - `chat_sessions` — `{ id (ULID), target_type ('expert'|'panel'), target_slug, status ('active'|'archived'), summary, summary_through_seq, created_at, updated_at }`. The "one active session per target" invariant is enforced at the application layer (`ChatRepository.findActiveSession` plus `archiveSession` before `createSession` in the chat command), not by a DB constraint, so the migration stays portable across libsql / Turso without partial-index syntax differences.
  - `chat_turns` — `{ id (ULID), chat_id (FK CASCADE), seq, role ('user'|'expert'), expert_slug (NULL for user turns), content, is_mention, tokens_in, tokens_out, created_at }` with `UNIQUE (chat_id, seq)` (declared in `005_chat.sql`) plus `idx_chat_turns_chat_seq` for ordered reads.
- **Atomic seq allocation** via `INSERT … SELECT COALESCE(MAX(seq), 0) + 1 …` in `ChatRepository.addTurn` so the read-and-increment happens in a single statement: no application-side race window even when a future caller concurrently appends to the same chat.
- **No reuse of `debates` / `turns`.** The structured-debate tables stay focused on bounded debates with phases, moderators, and cost ceilings.

**Alternatives considered**:
- **Reuse `debates` + `turns` with a `kind` column.** Smallest schema delta, but every chat-irrelevant column (`moderator`, `mode`, `cost_estimate`, terminal `status`) becomes nullable-and-meaningless for chat rows, and every debate query has to filter `WHERE kind = 'debate'`. The conceptual saving evaporates almost immediately.
- **App-side seq allocation (`SELECT MAX(seq) + 1` then `INSERT`).** Two statements, racy under concurrent appends — exactly the bug the single-statement form prevents. No retry loop needed because the seq is computed and inserted atomically.
- **Auto-increment `seq` via a trigger.** Works, but pushes write logic into SQL the JS code can't easily reason about, and the `INSERT … SELECT` form is portable across libsql/Turso without custom trigger setup.
- **Partial unique index on `(target_type, target_slug) WHERE status='active'`.** Would push the "one active session per target" rule into the schema, but libsql partial-index support is uneven and the application-layer guard is straightforward; deferred unless concurrent session creation becomes a real failure mode.

**Consequences**:
- ✅ Chat and debate evolve independently; adding a column for one cannot accidentally affect the other.
- ✅ `ChatRepository.addTurn` is a single round-trip with no app-side race window.
- ✅ Archive semantics are first-class: `council chat <target> --new` flips `status='archived'` on the active session and inserts a fresh one without touching turn history.
- ⚠️ The "one active session per target" invariant lives in application code, not the schema; a future caller bypassing the chat command could create a duplicate active row. Mitigated by a single chokepoint (`runExpertChat` / `runPanelChat`) and a follow-up issue if a second writer ever materialises.
- ⚠️ Two near-isomorphic table pairs (`debates`/`turns` and `chat_sessions`/`chat_turns`) — same trade-off as panel vs expert documents (ADR-007). Tolerated because the parent semantics differ.
- 📝 If a future feature needs to query "all turns for an expert across debates AND chats" it will need a UNION view; acceptable, that view does not exist yet.

### ADR-009: Regex-based document normalisation, not a Markdown/HTML parser
**Date**: 2026-05-10
**Status**: Accepted
**Context**: Roadmap 6.1 needs to extract plain text from `.md`, `.html`, and `.txt` documents to feed both FTS5 indexing and the persona-profile analyzer. The natural reach is a real parser per format (`marked` / `remark` for Markdown, `parse5` / `cheerio` for HTML). Council's actual need is far narrower: strip formatting and emit a normalised body suitable for tokenisation. The extractor is on the `council chat` startup hot path and must work in offline / air-gapped environments where heavy parser dependencies hurt install size and audit surface.

**Decision**: `src/core/documents/extractor.ts` uses a small set of hand-written regex normalisers per format (HTML entity decoding, tag stripping, Markdown punctuation removal, whitespace collapse). The JSDoc explicitly states "intentionally simple (regex-based); strips formatting but does not aim to be a full parser." Parser correctness is not promised; FTS5 robustness against imperfect tokenisation is.

**Alternatives considered**:
- **`marked` + `cheerio`** — production-grade output but adds ~400KB of runtime deps (transitive `entities`, `parse5`), expands the security audit surface, and pulls dependencies into a code path that already stays close to `node:fs`. Rejected as gold-plating for an FTS pre-processor.
- **`@mozilla/readability` / `jsdom`** — designed for article extraction, not arbitrary user docs; too opinionated and pulls in ~3MB of DOM emulation.
- **No normalisation (raw bytes → FTS)** — FTS5's tokeniser already handles punctuation, but Markdown link syntax (`[text](url)`) and HTML tags would inflate the index with noise tokens, and the persona-profile analyzer would receive markup soup.

**Consequences**:
- ✅ Zero runtime dependencies for extraction; install size unchanged.
- ✅ Fast, predictable, offline-safe — the extractor never touches the network or spawns subprocesses.
- ✅ Easy to audit: ~100 lines of regex with explicit test coverage per format.
- ⚠️ Pathological inputs (deeply-nested HTML, custom Markdown extensions) may produce imperfect text. Acceptable: FTS5 ranking absorbs noise, and the persona analyzer treats every fenced document as untrusted data anyway.
- 📝 If a real parser is ever needed (e.g. `.docx` / `.pdf` in Phase 8), it lands in a NEW module behind a format-dispatched interface — not by replacing the regex normalisers wholesale.

### ADR-008: Persona profile analysis — LLM extraction with single-retry, multi-layer sanitisation
**Date**: 2026-05-09
**Status**: Accepted
**Context**: Roadmap 6.2 turns persona-expert documents (CVs, design docs, RFCs, prior emails) into a structured behavioural profile that the prompt-builder injects as `[N] PERSONA PROFILE`. The mechanics had three open questions: (1) heuristic vs LLM extraction, (2) how to budget retries when the LLM returns malformed JSON, and (3) how to defend a privileged system prompt against injection through user-controlled file content.

**Decision**:
1. **LLM extraction via a transient "Profile Analyzer" expert.** Register, send a meta-prompt with fenced document blocks + any `existingProfile` to update, parse the JSON response into `PersonaProfile`. Tear the analyzer down in a `finally` block (engine-cleanup failures surface as warnings, never mask the analysis result).
2. **One retry on malformed JSON.** A single retry absorbs transient streaming truncation; persistent malformedness throws `Error("Profile analyzer returned unparsable JSON after retry")`. No exponential back-off, no second retry — the cost ceiling is two LLM calls per persona refresh. "Malformed" is permissive: a leading ```` ```json ```` / ```` ``` ```` code fence is stripped, then `JSON.parse` runs; the result is treated as malformed only if the parse throws OR `communicationStyle` / `epistemicStance` are missing or empty (the two narrative fields the profile cannot do without). Other fields are coerced (non-string entries dropped from arrays; non-strings become `""`) rather than triggering a retry.
3. **Defense-in-depth sanitisation:**
   - System prompt explicitly marks document content as untrusted data.
   - Document bodies are wrapped in `<documents>` fences; every `<` in interpolated content is escaped to `&lt;` so an XML-like tag cannot close the fence prematurely.
   - `existingProfile` fields are run through `sanitizePromptField` (`src/core/prompt-sanitize.ts`) — C0 controls stripped, Unicode line breaks (NEL / U+2028 / U+2029) and CR/LF runs collapsed, bracketed `[N]` section markers defanged to `(sec-N)`, length capped at 2000 chars — BEFORE the per-character `<` escape is applied, layering field-level and fence-level defenses.

**Alternatives considered**:
- **Heuristic extraction (n-gram frequencies, regex stance phrases).** Cheap and offline, but cannot capture nuanced behavioural patterns or update an existing profile coherently. Kept as a fallback elsewhere (`recallMemory`); not appropriate for persona profiles.
- **Multi-retry with exponential backoff.** Out of proportion for a JSON-parse failure mode; wastes premium-request budget on a structural problem the model is unlikely to fix on its own.
- **Single-pass sanitisation (just the `<` escape, or just `sanitizePromptField`).** Either layer alone has known bypasses (e.g. raw newlines surviving the `<` escape; `<` payloads surviving `sanitizePromptField`'s defang-but-don't-escape rule). Stacking is the cheap, robust answer.

**Consequences**:
- ✅ Profile quality is meaningfully better than heuristics — the LLM can synthesise `epistemicStance` and `decisionPatterns` from prose.
- ✅ Bounded cost: at most 2 LLM calls per `council chat <persona>` invocation that detected document changes.
- ✅ Hardened against fence-break, `[N]`-marker spoofing, runaway-length fields, and C0 / Unicode-line-break payloads (regression tests live in `tests/unit/core/documents/profile-analyzer.test.ts`, with the dedicated sanitization assertions starting around the `escapes fence-breaking characters in the existing-profile block` case).
- ⚠️ Still depends on the engine respecting the "treat fenced content as data" instruction. Mitigated by the field-level + fence-level escape layers, but not absolutely guaranteed for all future models.
- 📝 The transient-analyzer cleanup pattern is reusable: see `src/core/auto-compose.ts` for the original instance.

### ADR-007: `panel_documents` schema mirrors `expert_documents`, with `source` discriminator
**Date**: 2026-05-09
**Status**: Accepted
**Context**: Roadmap 6.7 (Panel Document Folder) adds a panel-shared RAG corpus that participates in the same FTS5 `document_index` as expert docs. The corpus has two provenance kinds: a managed folder auto-provisioned at `~/Council/panels/<name>/docs/` and an arbitrary number of user-linked external folders. Panels are addressed by `name` (string PK), not by ULID like experts. Two design questions: (1) one table or two for managed vs linked? (2) reuse the `expert_documents` shape verbatim, or design fresh?

**Decision**: Migration 009 creates two tables:
- **`panel_linked_folders`** — small registry of external folders per panel (`{ id (ULID), panel_name (FK CASCADE), folder_path, created_at }` with `UNIQUE (panel_name, folder_path)`).
- **`panel_documents`** — file tracking, intentionally near-isomorphic to `expert_documents`: `{ id (ULID), panel_name (FK CASCADE → panel_library.name), source ('managed' | 'linked'), file_path, filename, checksum, size_bytes, word_count, status, processed_at, created_at }` with `UNIQUE (panel_name, file_path)` and `idx_panel_documents_panel (panel_name, status)`.

Provenance is a column on the per-file row, not a separate table. FTS index entries differentiate panel docs from expert docs via `source_type='panel'` (already in migration 007).

**Alternatives considered**:
- **Single unified `documents` table for experts + panels.** Forces every row to carry both an `expert_slug` and a `panel_name` (one always NULL), complicating FK constraints (CASCADE on different parents) and indexing. The shapes are identical but the parent semantics aren't.
- **Separate `panel_managed_documents` and `panel_linked_documents` tables.** Doubles the surface for queries that don't care about provenance ("how many docs does this panel have?") and makes the scanner query the same row shape twice.
- **Store linked folders in a JSON column on `panel_library`.** Fast to write, but precludes `ON DELETE CASCADE`, breaks per-folder indexing, and forces the scanner to round-trip through application-level JSON parsing for every read.

**Consequences**:
- ✅ The expert and panel scanners share the same `DocumentDetectionResult` shape and the same FTS5 indexer, with provenance plumbed through as opaque metadata.
- ✅ `ON DELETE CASCADE` on both tables means `panel delete <name>` cleans up linked-folder registrations and per-file rows automatically; the FTS index is purged separately by the unlink/delete handlers.
- ✅ The `source` discriminator lets the scanner enforce the rule that **only the managed folder is auto-provisioned** while linked folders require an explicit `council panel docs link` (with up-front symlink rejection).
- ⚠️ Two near-isomorphic tables (`expert_documents` and `panel_documents`) duplicate column definitions. Tolerated; consolidation would couple two independent migration tracks.

### ADR-006: `migrateBuiltInTemplates` takes both `library` and `db` explicitly
**Date**: 2026-05-08
**Status**: Accepted
**Context**: Roadmap 4.6 needed a one-shot migration of the built-in panel templates' inline experts into the new library format (`~/Council/experts/<slug>.yaml` + an `expert_library` SQLite row) plus a rewrite of each panel into `~/Council/panels/<name>.yaml` with slug references (rows in `panel_library` + `panel_members`). The `ExpertLibrary` interface (`src/core/expert-library.ts`) intentionally abstracts the storage backend for experts only; it does NOT expose the `panel_library` / `panel_members` tables. The first implementation reached for the DB by `(library as FileExpertLibrary).getDb()`, an unsafe cast that hid the dependency from the type system and broke for any non-file backend.

**Decision**: `migrateBuiltInTemplates(dataHome, library, db, options?)` accepts the `CouncilDatabase` handle as an explicit parameter alongside the library. The migration writes expert YAMLs (and library rows) through `library`/`ExpertLibraryRepository`, and panel rows through `db` directly. `isMigrationNeeded(dataHome, db?)` also accepts the DB optionally, returning true when either the experts directory is empty OR the `expert_library` table is empty OR the `panel_library` table is empty — so a DB reset that lost either side of the registry (with YAMLs still on disk) triggers a re-register pass that refreshes stale `panel_library` metadata from the user-edited panel YAML and materialises inline expert overrides into `expert_library`.

**Alternatives considered**:
- **Add `panel_library` / `panel_members` methods to the `ExpertLibrary` interface.** Rejected: panel storage is conceptually separate from expert storage, and a generic library backend (e.g. a future remote/Cloud library) might not own panel state at all. Polluting the interface would force every backend to implement panel methods it doesn't need.
- **Introduce a `PanelLibrary` interface and pass that instead.** Worth doing eventually but premature for a single caller (the migration). Deferred until a second consumer materialises.
- **Keep the `getDb()` cast but make it an explicit method on `ExpertLibrary`.** Same downsides as the first alternative, plus it leaks a libsql-specific handle through the abstraction.

**Consequences**:
- ✅ Type-safe: no `any` cast, no narrowing assumption about the library implementation.
- ✅ Testable: tests pass an in-memory `CouncilDatabase` directly instead of constructing a backing `FileExpertLibrary` just to extract its DB.
- ✅ Crash-recoverable: with the DB handle available, the migration can register panel rows idempotently and re-sync from disk after a DB reset.
- ⚠️ Two parameters where one might feel cleaner. Acceptable until a `PanelLibrary` abstraction earns its keep.

### ADR-001: Use @github/copilot-sdk as primary AI engine
**Date**: 2026-05-06
**Status**: Accepted
**Context**: Council needs multi-model AI access (GPT, Claude, Gemini) for expert panels. Options were: direct provider APIs (OpenAI, Anthropic, Google separately), Vercel AI SDK (unified wrapper), or GitHub Copilot SDK.
**Decision**: Use `@github/copilot-sdk` as the primary engine, behind a `CouncilEngine` abstraction interface.
**Alternatives considered**: Vercel AI SDK (good unified interface but requires separate API keys per provider), direct provider APIs (maximum control but complex key management and billing).
**Consequences**: Zero API key setup for users with Copilot subscription. Locked to Copilot's model availability and rate limits. SDK is in public preview and may break. Mitigated by `CouncilEngine` interface that allows swapping engines. Direct provider adapters planned for Phase 8.

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
