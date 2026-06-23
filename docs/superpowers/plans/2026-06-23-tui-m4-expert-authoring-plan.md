# Council TUI — Milestone 9.5 (M4 Expert Authoring & Training) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Author experts inside the TUI — create generic + persona experts via a guided form, edit them, delete them (with affected-panel warnings), add/list/remove training documents, and (engine-backed) refresh a persona's learned profile. Behind `COUNCIL_TUI=1`; the full CLI stays untouched.

**Architecture:** A pure, fully-tested `expert-authoring` adapter assembles + validates an `ExpertDefinition` from flat form-field values (mirroring `expert create`'s slug regex + `ExpertDefinitionSchema` + the `[NN]`-marker `superRefine`), and wraps create/update/delete over an injected `ExpertLibrary`. A reusable `ExpertFormScreen` (built on the M3 input-capture + mode-gated field-editing pattern) drives create/edit. A `documents` adapter wraps the offline indexing (`DocumentRepository` + `DocumentIndexer`). Persona profile synthesis (the only engine-dependent step) runs through the shared `runWithEngine` helper and is unit-tested with `MockEngine`.

**Tech Stack:** TypeScript ESM, Ink 7, React 19, `ink-text-input`, `react-router`, Zod (`ExpertDefinitionSchema`), Vitest + `ink-testing-library` + `MockEngine`.

## Global Constraints (every task implicitly includes these)
- Node ≥ 24; ESM; **`.js` import specifiers**; `.tsx` starts with `import React from "react";`.
- Named exports only; explicit return types; `interface` for object shapes; `readonly` default; **no `any`** (only the documented `as … | undefined` context narrowing).
- **TDD (Sentinel-enforced):** the `test(tui)` commit (tests ONLY, RED-confirmed) precedes its `feat(tui)` commit. Never combine.
- **⚠️ LEARNINGS (M0–M3 — caused rejections, apply to EVERY task):**
  1. **100% branch coverage on every new `.ts`** (adapters). Cover EVERY validation/assemble branch (each required-field failure, slug-regex reject, expertise-empty reject, `[NN]`-marker reject, persona-vs-generic, optional-field present/absent). Verify with a targeted `--coverage.include` run before the feat commit.
  2. **Tests ASSERT behavior** (not "no throw"); mutation-check critical guards.
  3. **Ink broadcasts each keypress to ALL active `useInput`.** Forms use the **input-capture** context (`useInputCapture().setCaptured(true)` on mount) so `AppRouter`'s global keys are gated; split intra-screen input into mode-gated handlers (`nav` vs `edit`). NO per-screen Esc that double-fires.
  4. **A lone `Esc` (`\u001b`) needs a REAL timer wait** in tests; arrows/Tab/Enter/printables are immediate.
  5. **Sanitize** every untrusted string at the `<Text>` sink with `toSingleLineDisplay`.
  6. **Mutations are real side effects** — adapters take INJECTED library/repo deps so they're unit-tested offline; the `index.tsx` glue supplies the real ones.
  7. **Engine work** uses `runWithEngine` + `--engine mock` (`MockEngine`) for deterministic offline tests (see `src/cli/run-with-engine.ts`, `convene.ts`).
- **Test color:** `tests/setup.ts` forces `FORCE_COLOR=3` (assert `\u001b[7m` for selected rows).
- **Per increment:** worktree off `main`; `pnpm install --frozen-lockfile`; `pnpm test`+`lint`+`typecheck` before PR; PARENT invokes Sentinel; merge on APPROVED/CONDITIONAL. Delegated implementers STOP after opening the PR.

## Verified seams (against `main` 2026-06-23 — source of truth)
- **Write API** (`src/core/expert-library.ts`, `FileExpertLibrary`): `create(def: ExpertDefinition): Promise<void>` (throws on duplicate slug / invalid); `update(slug: string, patch: Partial<ExpertDefinition>): Promise<void>` (throws "not found"); `delete(slug: string, options: { force: boolean }): Promise<{ affectedPanels: readonly string[] }>`; `get(slug): Promise<ExpertDefinition | null>`; `list()`; `panelsFor(slug): Promise<readonly string[]>`. Persists `<dataHome>/experts/<slug>.yaml`.
- **Slug:** `/^[a-z0-9][a-z0-9-]{0,63}$/` (`SLUG_RE` in expert-library.ts; `validateSlug` in `cli/commands/expert.ts`).
- **`ExpertDefinition`** (`src/core/expert.ts`, `ExpertDefinitionSchema`): required `slug`, `displayName`, `role`, `expertise{ weightedEvidence: string[] (min 1); referenceCases: string[] (default []); notExpertIn: string[] (default []) }`, `epistemicStance`; optional `model`, `debateProtocol`, `outputContract`, `forbiddenMoves`, `personality`, `personaDescription`, `docsPath`; `kind: "generic"|"persona"` (default generic). A `superRefine` REJECTS `"[NN]"` (e.g. `[1]`) section markers in `displayName`/`role`/`personality`/`epistemicStance`. `allowlistExpertDefinition(expert, slugOverride?)` copies only schema fields.
- **Documents (offline):** `DocumentRepository` (`src/memory/repositories/document-repository.ts`): `findByExpert(slug)`, `markRemoved(...)`, `clearForRetrain(slug)`. `DocumentIndexer` (`src/core/documents/indexer.ts`): `index/remove/removeAll` (SQLite FTS, offline). Docs live on disk under `<dataHome>/experts/<slug>/docs`.
- **Training (engine):** `createDocumentProcessor()` (`src/core/documents/processor.ts`) `process(slug, docsPath, …, onProgress)` with `ProcessingProgress { status: "success"|"failed"|"needs-review"; … }`; profile synthesis (`analyzeDocuments`, `src/core/documents/profile-analyzer.ts`) and `ProfileRepository.upsert/findBySlug/delete` (`src/memory/repositories/profile-repository.ts`). `analyzeDocuments`/profile refresh use the ENGINE.
- **Engine helper:** `runWithEngine` (`src/cli/run-with-engine.ts`); `MockEngine` (`src/engine/mock/mock-engine.ts`) for deterministic tests.
- **TUI infra already on main:** `useInputCapture` (`components/InputCaptureProvider.tsx`), `useAsyncResource`, `DataProvider`/`useData`, `SettingsScreen` (COPY its form/mode/edit pattern), `ExpertsScreen`/`ExpertDetailScreen`, `AppRouter` (route-aware Esc + `mode !== "palette" && !captured` gate), the command palette (`palette-commands.ts`).

## PR grouping (6 PRs)
| PR | Branch | Tasks | Dep |
|----|--------|-------|-----|
| PR-A | `feature/tui-expert-authoring-adapter` | Task 1 (`expert-authoring` adapter: field descriptors + `validateExpertForm` + `buildExpertDefinition` + `createExpertAuthoringSource{create,update,delete,loadForEdit}`) | M3 |
| PR-B | `feature/tui-expert-create` | Task 2 (`ExpertFormScreen` — guided form via input-capture/mode-gated editing) + Task 3 (create wiring: palette/key entry → form → `create` → navigate to detail) | PR-A |
| PR-C | `feature/tui-expert-edit` | Task 4 (edit mode: load existing → prefill → `update`; slug read-only) | PR-B |
| PR-D | `feature/tui-expert-delete` | Task 5 (delete confirm screen with affected-panel warning → `delete`) | PR-B |
| PR-E | `feature/tui-expert-documents` | Task 6 (`documents` adapter + `ExpertDocumentsScreen`: list/add/remove indexed docs, offline) | PR-B |
| PR-F | `feature/tui-expert-training` | Task 7 (persona profile refresh via `runWithEngine`/processor, `MockEngine`-tested) | PR-E |

PR-C/PR-D/PR-E are independent of each other (all depend on PR-B); they may run in parallel (small shared-file conflicts on `AppRouter`/`DataProvider`/`index.tsx` resolved by rebasing the later merges).

## File Structure
```
packages/cli/src/tui/
  adapters/expert-authoring.ts    descriptors + validateExpertForm + buildExpertDefinition + createExpertAuthoringSource (NEW)
  adapters/expert-documents.ts    list/add/remove indexed docs over DocumentRepository+DocumentIndexer (NEW, PR-E)
  screens/ExpertFormScreen.tsx    reusable create/edit form (NEW, PR-B)
  screens/ExpertDeleteScreen.tsx  confirm + affected panels (NEW, PR-D)
  screens/ExpertDocumentsScreen.tsx  docs list/add/remove (NEW, PR-E)
  router/routes.ts                add /experts/new, /experts/:slug/edit, /experts/:slug/delete, /experts/:slug/docs (MODIFY)
  router/AppRouter.tsx            wire the new routes (MODIFY)
  components/DataProvider.tsx     add experts authoring + documents sources (MODIFY)
  index.tsx                       glue: build sources from FileExpertLibrary + repos (MODIFY)
```

---

## Task 1: `expert-authoring` adapter (PR-A) — test-first, 100% branch coverage
**Files:** Create `src/tui/adapters/expert-authoring.ts`; Test `tests/unit/tui/expert-authoring.test.ts`.

**Produces:**
```ts
export interface ExpertFormValues {            // flat string form state
  readonly slug: string; readonly displayName: string; readonly role: string;
  readonly weightedEvidence: string;           // newline- or comma-separated; ≥1 non-empty required
  readonly referenceCases: string; readonly notExpertIn: string;   // optional lists
  readonly epistemicStance: string;
  readonly kind: "generic" | "persona";
  readonly personaDescription: string;         // used only when kind==="persona"
  readonly model: string;                      // optional
}
export interface ExpertFormFieldError { readonly field: keyof ExpertFormValues; readonly error: string; }
export type BuildResult =
  | { readonly ok: true; readonly definition: import("../../core/expert.js").ExpertDefinition }
  | { readonly ok: false; readonly errors: readonly ExpertFormFieldError[] };
export function emptyExpertForm(): ExpertFormValues;
export function expertToForm(def: import("../../core/expert.js").ExpertDefinition): ExpertFormValues;   // for edit prefill
export function validateExpertForm(values: ExpertFormValues): BuildResult;   // validates + assembles
export interface ExpertAuthoringSource {
  readonly loadForEdit: (slug: string) => Promise<ExpertFormValues | undefined>;
  readonly create: (values: ExpertFormValues) => Promise<BuildResult>;       // validate→ok→library.create; on dup/invalid, ok:false
  readonly update: (slug: string, values: ExpertFormValues) => Promise<BuildResult>;  // slug held fixed
  readonly remove: (slug: string) => Promise<{ readonly affectedPanels: readonly string[] }>;
  readonly affectedPanels: (slug: string) => Promise<readonly string[]>;     // library.panelsFor
}
export function createExpertAuthoringSource(deps: {
  readonly library: {
    get(slug: string): Promise<import("../../core/expert.js").ExpertDefinition | null>;
    create(def: import("../../core/expert.js").ExpertDefinition): Promise<void>;
    update(slug: string, patch: Partial<import("../../core/expert.js").ExpertDefinition>): Promise<void>;
    delete(slug: string, options: { force: boolean }): Promise<{ affectedPanels: readonly string[] }>;
    panelsFor(slug: string): Promise<readonly string[]>;
  };
}): ExpertAuthoringSource;
```

**`validateExpertForm`** — assemble + validate, returning per-field errors (mirror the CLI):
- `slug`: trim; must match `/^[a-z0-9][a-z0-9-]{0,63}$/` else `{ field:"slug", error:"Lowercase letters, digits, hyphens (max 64)" }`.
- `displayName`/`role`/`epistemicStance`: non-empty (trimmed) else `"Required"`.
- `weightedEvidence`: split on `/[\n,]/`, trim, drop empties → array; must have ≥1 else `{ field:"weightedEvidence", error:"At least one is required" }`.
- `referenceCases`/`notExpertIn`: same split → arrays (may be empty).
- `model`: trim; empty → omit the field (optional).
- `personaDescription`: when `kind==="persona"`, trim; (optional in schema — may be empty); when `kind==="generic"`, ignore it.
- Assemble `{ slug, displayName, role, expertise:{weightedEvidence, referenceCases, notExpertIn}, epistemicStance, kind, ...(model?), ...(personaDescription? when persona & non-empty) }` and run `ExpertDefinitionSchema.safeParse(...)`; if it fails (e.g. the `[NN]`-marker `superRefine`), map the first issue to a field error (`{ field: <path[0]> as keyof ExpertFormValues mapped, error: issue.message }`). Collect ALL field-level errors (run the cheap checks first, then schema); return `{ ok:false, errors }` if any, else `{ ok:true, definition }`.

**`expertToForm`**: inverse — join arrays with `"\n"`, copy scalars, `model ?? ""`, `personaDescription ?? ""`.

**`createExpertAuthoringSource`**:
- `create`: `const r = validateExpertForm(values); if (!r.ok) return r;` then `if (await deps.library.get(r.definition.slug)) return { ok:false, errors:[{field:"slug", error:"An expert with this slug already exists"}] };` then `await deps.library.create(r.definition); return r;`. (Wrap the `library.create` in try/catch → map a thrown error to `{ ok:false, errors:[{field:"slug", error: toSingleLineDisplay(String(e))}] }`? — keep simple: pre-check dup; let other throws propagate? Prefer: catch and return a slug-field error so the form shows it.)
- `update`: `validateExpertForm(values)`; force the slug to the existing one (slug is read-only in edit); on ok → `await deps.library.update(slug, r.definition)`; return r.
- `remove`: `deps.library.delete(slug, { force: true })`.
- `affectedPanels`/`loadForEdit`: `panelsFor` / `get`→`expertToForm` (undefined if null).

- [ ] **Step 1 (test, RED):** cover EVERY branch — `emptyExpertForm`/`expertToForm` round-trip; `validateExpertForm`: bad slug, empty required (each of displayName/role/epistemicStance), empty weightedEvidence, a `[1]` marker in displayName (→ superRefine error), persona with personaDescription, generic ignoring personaDescription, model present/absent, a fully-valid generic and a fully-valid persona; `createExpertAuthoringSource.create` (valid→library.create called with the assembled def; duplicate slug via fake `get`→non-null → ok:false; invalid form → ok:false, library.create NOT called); `update` (slug held fixed; ok→library.update called); `remove` (forwards to delete force:true); `affectedPanels`/`loadForEdit`. Targeted coverage → 100%. Commit `test(tui): add failing tests for expert-authoring adapter`.
- [ ] **Step 2 (feat):** implement; 100% coverage; `feat(tui): add expert-authoring adapter`.

---

## Task 2 + 3: `ExpertFormScreen` + create wiring (PR-B) — test-first
**Files:** Create `src/tui/screens/ExpertFormScreen.tsx`; Modify `DataProvider.tsx` (`expertAuthoring?: ExpertAuthoringSource`), `routes.ts` (`expertNew: "/experts/new"`), `AppRouter.tsx`, `index.tsx`; the palette (`palette-commands.ts` — add a "New expert" action) and/or a key on `ExpertsScreen` (e.g. `n` → navigate `/experts/new`); Test `tests/unit/tui/expert-form-screen.test.tsx`.

**`ExpertFormScreen` behavior** (reuse the M3 SettingsScreen mode-gated form pattern):
- Props `{ readonly theme: SemanticTheme; readonly mode: "create" | "edit"; readonly slug?: string }`.
- `const { setCaptured } = useInputCapture();` capture on mount/uncapture on unmount.
- State: `values: ExpertFormValues` (create → `emptyExpertForm()`; edit → load via `expertAuthoring.loadForEdit(slug)` in `useAsyncResource`/effect, prefill, slug read-only), a flat list of editable form fields (slug [read-only in edit], displayName, role, weightedEvidence, referenceCases, notExpertIn, epistemicStance, kind [enum generic/persona], personaDescription [shown when persona], model), `cursor`, an inner `mode: "nav"|"edit"`, per-field errors from `validateExpertForm` (show on submit), and a top-level submit.
- Field editing: string → `ink-text-input` (multi-line lists can stay single-line comma-separated for v1, or accept `\n` literally — keep single-line input + comma separation); enum (`kind`) → `←/→` cycle. Mirror SettingsScreen's edit/commit/cancel.
- `Ctrl+S` (nav mode) → `const r = mode === "create" ? await expertAuthoring.create(values) : await expertAuthoring.update(slug, values);` if `r.ok` → navigate to `/experts/<slug>` (detail) with a "Saved" note; if `!r.ok` → show the field errors inline (move cursor to the first errored field).
- `Esc` (nav) → `navigate(-1)` (confirm-discard optional; keep simple).
- Sanitize all displayed values/labels/errors.

- [ ] **Step 1 (test, RED):** wrap in `InputCaptureProvider`+`DataProvider`(with a fake `expertAuthoring`)+`MemoryRouter`. Cover: renders all create fields; edit a string field (type → staged), cycle `kind` enum; `Ctrl+S` with an INVALID form (e.g. empty slug) → shows the field error and does NOT navigate / does NOT call `create`; `Ctrl+S` with a VALID form → calls `create(values)` once and navigates to `/experts/<slug>` (assert via a probe route); `Esc` returns. Commit `test(tui): add failing tests for ExpertFormScreen create`.
- [ ] **Step 2 (feat):** implement the screen + wire `/experts/new` in `AppRouter`, add the "New expert" palette command (and/or `n` on ExpertsScreen), add `expertAuthoring?` to `DataProvider`, build `createExpertAuthoringSource({ library: new FileExpertLibrary(dataHome, db) })` in `index.tsx` glue. Commit `feat(tui): add ExpertFormScreen and create flow`.

---

## Task 4: Expert edit (PR-C) — test-first
**Files:** Modify `routes.ts` (`expertEdit: "/experts/:slug/edit"`), `AppRouter.tsx`, `ExpertDetailScreen.tsx` (add an `e` key → navigate edit) ; Test extend.
- Render `ExpertFormScreen mode="edit" slug={:slug}` on `/experts/:slug/edit`; it `loadForEdit(slug)` → prefill; slug field is read-only (display only, not editable); `Ctrl+S` → `update`. On success → navigate to the detail.
- [ ] Test-first: editing an existing expert (fake `loadForEdit` → form values; change a field; `Ctrl+S` → `update(slug, values)` called; slug not editable). Then implement.

## Task 5: Expert delete (PR-D) — test-first
**Files:** Create `src/tui/screens/ExpertDeleteScreen.tsx`; `routes.ts` (`expertDelete: "/experts/:slug/delete"`), `AppRouter.tsx`, `ExpertDetailScreen.tsx` (add `d` → navigate delete); Test.
- On mount: `affectedPanels(slug)` (via the authoring source). Render the expert slug + a warning listing affected panels (sanitized) + a confirm prompt (`y` confirm / `n` or `Esc` cancel). On confirm → `expertAuthoring.remove(slug)` → navigate to `/experts` (list). Capture input.
- [ ] Test-first: shows affected panels; `y` calls `remove(slug)` and navigates to the list; `n`/`Esc` cancels (no remove). Then implement.

## Task 6: Documents (PR-E) — test-first
**Files:** Create `src/tui/adapters/expert-documents.ts` + `src/tui/screens/ExpertDocumentsScreen.tsx`; `routes.ts` (`expertDocs: "/experts/:slug/docs"`), `AppRouter.tsx`, `ExpertDetailScreen.tsx` (`o` → docs, persona-only); `DataProvider.tsx`; `index.tsx`; Tests.
- `expert-documents` adapter (100% covered, injected `DocumentRepository`+`DocumentIndexer`+fs): `list(slug)` → indexed docs (path/status); `remove(slug, file)` → `markRemoved`+`indexer.remove`; `add(slug, filePath)` → copy into `<dataHome>/experts/<slug>/docs` + index (offline — extraction/profile NOT here). Keep the engine-dependent profile refresh OUT (that's PR-F).
- `ExpertDocumentsScreen`: list documents (SelectableList), `a` prompt for a path → `add`, `x`/`d` on a selected doc → `remove`. Capture input; loading/empty/error.
- [ ] Test-first (adapter 100%; screen list/add/remove with fakes). Then implement.

## Task 7: Persona training / profile refresh (PR-F) — test-first
**Files:** Modify `ExpertDocumentsScreen.tsx` (a `t`/"Train" action) or a small `ExpertTrainScreen`; a training adapter that runs the profile synthesis via `runWithEngine`; Tests using `MockEngine`.
- A `trainPersona(slug, { engineFactory })` flow: run `createDocumentProcessor().process(slug, docsPath, …, onProgress)` (or just the profile-synthesis portion) under `runWithEngine` with `--engine mock`; surface `onProgress` events (per-file status) and the final `profileUpdated`/`profileError` in the UI. Deterministic offline via `MockEngine`.
- [ ] Test-first with `MockEngine` (process emits progress; profile upsert called; error path shows an error). Then implement. **Persona-only**; document that real profile synthesis needs the engine.

## Self-Review
1. **Spec coverage (story epics A "create/train a persona expert", B "create an expert"):** create generic+persona → Tasks 1–3; edit → Task 4; delete w/ warnings → Task 5; add/list/remove docs → Task 6; train/refresh profile → Task 7.
2. **Placeholder scan:** none — adapter fully specified; screens reuse the proven M3 form pattern.
3. **Type consistency:** `ExpertFormValues`/`BuildResult`/`ExpertAuthoringSource` defined once; `create/update` return `BuildResult` so the form shows field errors uniformly.

## Risks & Mitigations
| Risk | Mitigation |
|------|-----------|
| Form keystrokes double-dispatch with global keys | input-capture + mode-gated handlers (M3 pattern), reused. |
| `library.create/update` throw (dup/invalid/storage) | pre-check dup via `get`; catch + map to a slug-field error so the form shows it; adapters tested with fake libraries. |
| Expertise lists are arrays (hard in a TUI) | v1 uses comma/newline-separated string fields → split on save; `weightedEvidence` ≥1 enforced. List-item editors deferred. |
| `[NN]` markers rejected by schema superRefine | `validateExpertForm` runs `ExpertDefinitionSchema.safeParse` and maps the issue to a field error. |
| Profile synthesis needs the engine | Task 7 isolates it behind `runWithEngine`; tested with `MockEngine`; create/edit/delete/docs stay offline. |
| Parallel PR-C/D/E conflicts on AppRouter/DataProvider/index | merge sequentially, rebasing later PRs (mechanical). |

## Execution Handoff
Plan saved to `docs/superpowers/plans/2026-06-23-tui-m4-expert-authoring-plan.md`. Execute via **subagent-driven-development**: PR-A first; PR-B next; PR-C/PR-D/PR-E may parallelize after PR-B; PR-F after PR-E. One delegated implementer per PR (stops at "PR opened"); the parent invokes Sentinel per PR and merges on APPROVED/CONDITIONAL.
