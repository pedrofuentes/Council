# Plan — Roadmap 6.3 Content Indexing (RAG) — superseded below

# Plan — Content Indexing (RAG, Roadmap 6.3)

Autopilot mode.

## Increments (single PR)
1. **RED** `test(documents): add failing tests for FTS5 indexer and retriever`
   - `tests/unit/core/documents/indexer.test.ts`
   - `tests/unit/core/documents/retriever.test.ts`
2. **GREEN** `feat(documents): add FTS5 document indexing and retrieval (Roadmap 6.3)`
   - `src/memory/migrations/007_document_index.sql`
   - `src/memory/db.ts` — register migration 007
   - `src/core/documents/indexer.ts`
   - `src/core/documents/retriever.ts`
3. Verify: `pnpm test && pnpm lint && pnpm typecheck && pnpm build`
4. Invoke Sentinel.

# ── Old plan below (panel composition, superseded) ──
# Plan — Roadmap 4.2 Panel Composition Model

Goal: Allow panels to reference experts by slug (from the expert library) or define them inline.

## Increments (single PR — autopilot)
1. **RED**: Add tests in `tests/unit/core/template-loader.test.ts` covering:
   - `PanelExpertEntrySchema` union (slug string or inline)
   - `PanelDefinitionSchema` with mixed/all-string/all-inline experts
   - Duplicate slug detection across both forms
   - Optional `description`
   - `min(1)` (single-expert panel)
   - `resolveExperts(entries, library)` — resolves slugs, passes inline, reports missing, empty
   - `loadUserPanel(name, dataHome)` — loads YAML from `<dataHome>/panels/<name>.yaml`
   - `loadUserPanel` path-traversal rejection
   - `listUserPanels(dataHome)`
   - `loadPanel(name, dataHome)` — user panels override built-ins
2. **GREEN**: Implement in `src/core/template-loader.ts`
   - `PanelExpertEntrySchema`
   - Update `PanelDefinitionSchema` (union, description optional, min(1)..max(8), dup-slug across forms)
   - `ResolvedPanelDefinition` type (all-inline)
   - `resolveExperts()`, `loadUserPanel()`, `listUserPanels()`, `loadPanel()`
   - Keep `loadTemplate()` returning a resolved (all-inline) panel — assert no slug refs in built-ins
   - Minimal downstream tweak: convene/auto-compose continue to compile (they consume only built-ins, which remain all-inline)
3. Run full suite (`pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`)
4. Invoke Sentinel, push branch, open PR
