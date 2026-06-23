# Council TUI — Milestone 9.4 (M3 Settings) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** An editable **Settings** screen on the `/settings` route — browse every config section, edit scalar fields (string / number-with-range / boolean / enum) with **inline Zod-mirrored validation**, and **Save** (persist via `updateConfigFields`) or **Cancel** (discard). Behind `COUNCIL_TUI=1`; the full CLI stays untouched.

**Architecture:** A pure, fully-tested `config-settings` adapter defines the editable **field descriptors** (path/label/section/kind/constraints), maps the current config → field states, validates a candidate value per field (mirroring the CLI's coercion), and saves changed fields atomically. A new **input-capture** context lets a focused form gate `AppRouter`'s global keys so editing keystrokes (and `Esc`) don't double-dispatch (the M2 "Ink broadcasts to all `useInput`" rule). The `SettingsScreen` is a thin Ink form consuming the adapter; `index.tsx` stays glue.

**Tech Stack:** TypeScript ESM, Ink 7, React 19, `ink-text-input` (single-line field editing — already a dep), `react-router`, Zod (via the config schema), Vitest + `ink-testing-library`.

## Global Constraints

Copied verbatim from `docs/designs/interactive-tui.md`, `AGENTS.md`, repo config, and `LEARNINGS.md` — every task implicitly includes these:

- **Runtime:** Node ≥ 24; ESM. **Import specifiers end in `.js`**. JSX classic runtime — every `.tsx` starts with `import React from "react";`.
- **Exports:** named only; explicit return types; `interface` for object shapes; `readonly` by default; **no `any`** (use `unknown` + guards; the only allowed narrowing is the documented optional-context cast).
- **TDD (Sentinel-enforced):** the `test(tui)` commit (tests ONLY, demonstrate RED) MUST precede its `feat(tui)` commit. Never combine.
- **⚠️ LEARNINGS from M0–M2 (these caused rejections — apply to EVERY task):**
  1. **100% branch coverage on every new `.ts`** (`config-settings.ts`). Cover EVERY branch (each field kind, each validation success/failure path, the `?? default` paths). Verify with a targeted `--coverage.include` run before the feat commit.
  2. **Tests must ASSERT behavior** (not "no throw"); for critical guards, mutation-check (disable the guard → the test must fail).
  3. **Ink broadcasts each keypress to ALL active `useInput` handlers.** Global keys live route/mode-aware in `AppRouter`; a focused form must gate AppRouter's input via the new **input-capture** context, and must NOT rely on a per-screen Esc that double-fires. Cover EVERY keyboard branch you add.
  4. **A lone `Esc` (`\u001b`) needs a REAL timer wait** in tests (`await new Promise(r => setTimeout(r, 120))`), NOT a `setImmediate` flush. Arrows/Tab/Enter/printables are immediate.
  5. **Sanitize** every untrusted string at the `<Text>` sink with `toSingleLineDisplay` (config values are user/file-derived). Audit every sink.
  6. **Entry/screen files are thin glue** — all logic in the tested `.ts` adapter.
- **Test color:** `tests/setup.ts` forces `FORCE_COLOR=3` (assert `\u001b[7m` for inverse/selected rows).
- **Per increment:** worktree off `main`; `pnpm install --frozen-lockfile`; `pnpm test`+`lint`+`typecheck` before PR; PARENT invokes Sentinel; merge on APPROVED/CONDITIONAL. Delegated implementers STOP after opening the PR.

## Config seams (verified against `main` 2026-06-23 — source of truth)

- **Schema** (`src/config/schema.ts`): `ConfigSchema` → `CouncilConfig`. **Editable scalar fields** (dot-path → kind, constraints):
  - `defaults.model` → string (min 1) · `defaults.engine` → enum `copilot|mock|openai|anthropic` · `defaults.maxRounds` → int 1–20 · `defaults.maxExperts` → int 2–8 · `defaults.maxWordsPerResponse` → int 50–2000
  - `telemetry.enabled` → boolean
  - `providers.openai.apiKeyEnvVar` / `providers.anthropic.apiKeyEnvVar` → string (env-var **NAME** only; optional)
  - `expert.recencyHalfLifeDays` → int 1–365
  - `documents.aiExtraction` → enum `off|ask|auto` · `documents.maxFileSizeMB` → number 1–500
  - `chat.recentTurnCount` → int 5–50 · `chat.summaryMaxWords` → int 100–2000 · `chat.longConversationWarning` → int 50–10000
  - `conclude.maxTranscriptChars` → int 1000–1000000
  - `qualityGate.mode` → enum `off|warn|regenerate` · `qualityGate.maxRegenerations` → int 0–3
  - `paths.dataHome` → string
  - **EXCLUDE from M3 editing** (arrays — display read-only or omit): `expert.supportedFormats`, `documents.aiExtractionAllowedExtensions`.
- **Read:** `loadConfig(): Promise<CouncilConfig>` (`src/config/index.js`).
- **Write:** `updateConfigFields(updates: readonly { key: string; value: string|number|boolean|readonly string[] }[]): Promise<void>` from `src/config/loader.js` — dot-notation keys, re-validates the WHOLE config via `ConfigSchema.safeParse` and THROWS a formatted error on invalid. (Re-exported `updateConfigField` exists too, but `updateConfigFields` does an atomic batch — import it from `../config/loader.js` in the glue.)
- **Persistence:** YAML at `<getCouncilHome()>/config.yaml`.

## PR grouping (4 PRs)

| PR | Branch | Tasks | Dep |
|----|--------|-------|-----|
| PR-A | `feature/tui-settings-adapter` | Task 1 (`config-settings` adapter: descriptors + `buildSettingsFields` + `validateField` + `createSettingsDataSource`) | M2 |
| PR-B | `feature/tui-input-capture` | Task 2 (`InputCaptureContext` + gate `AppRouter`'s `useInput` on `!captured`) | M2 |
| PR-C | `feature/tui-settings-screen` | Task 3 (`SettingsScreen` render sections/fields + field-nav + capture-on-mount + Esc/route wiring) | PR-A, PR-B |
| PR-D | `feature/tui-settings-edit` | Task 4 (field editing per kind + inline validation + dirty staging + Ctrl+S Save / discard) | PR-C |

## File Structure
```
packages/cli/src/tui/
  adapters/config-settings.ts     descriptors + buildSettingsFields + validateField + createSettingsDataSource (NEW)
  components/InputCaptureProvider.tsx  InputCaptureContext + useInputCapture() (NEW)
  screens/SettingsScreen.tsx      sectioned form; consumes the adapter + capture context (NEW)
  router/AppRouter.tsx            gate top-level useInput on !captured; /settings → SettingsScreen (MODIFY)
  components/DataProvider.tsx     add settings?: SettingsDataSource (MODIFY)
  index.tsx                       build settings source from loadConfig + updateConfigFields (MODIFY glue)
```

---

## Task 1: `config-settings` adapter (PR-A) — test-first, 100% branch coverage

**Files:** Create `packages/cli/src/tui/adapters/config-settings.ts`; Test `packages/cli/tests/unit/tui/config-settings.test.ts`.

**Produces:**
```ts
export type SettingsFieldKind = "string" | "number" | "boolean" | "enum";

export interface SettingsFieldDescriptor {
  readonly path: string;                 // dot-path, e.g. "defaults.maxRounds"
  readonly section: string;              // e.g. "Defaults"
  readonly label: string;                // e.g. "Max rounds"
  readonly kind: SettingsFieldKind;
  readonly min?: number;                 // number kind
  readonly max?: number;                 // number kind
  readonly integer?: boolean;            // number kind
  readonly options?: readonly string[];  // enum kind
  readonly optional?: boolean;           // string kind (may be empty)
}

export interface SettingsFieldState extends SettingsFieldDescriptor {
  readonly value: string;                // current value rendered as a string ("" when unset)
}

export type ValidateResult =
  | { readonly ok: true; readonly value: string | number | boolean }
  | { readonly ok: false; readonly error: string };

export interface SettingsDataSource {
  readonly load: () => Promise<readonly SettingsFieldState[]>;
  readonly save: (changes: readonly { readonly path: string; readonly value: string | number | boolean }[]) => Promise<void>;
}

export const SETTINGS_FIELDS: readonly SettingsFieldDescriptor[];   // the descriptor list (the 18 scalar fields above, in section order)
export function readFieldValue(config: unknown, path: string): string;   // dot-path read → string ("" if missing/undefined)
export function validateField(field: SettingsFieldDescriptor, raw: string): ValidateResult;
export function buildSettingsFields(config: unknown): readonly SettingsFieldState[];
export function createSettingsDataSource(deps: {
  readonly loadConfig: () => Promise<unknown>;
  readonly updateConfigFields: (updates: readonly { readonly key: string; readonly value: string | number | boolean }[]) => Promise<void>;
}): SettingsDataSource;
```

**`SETTINGS_FIELDS`** — define all 18 descriptors from the verified schema (section/label/kind/constraints), e.g.:
```ts
export const SETTINGS_FIELDS: readonly SettingsFieldDescriptor[] = [
  { path: "defaults.model", section: "Defaults", label: "Default model", kind: "string" },
  { path: "defaults.engine", section: "Defaults", label: "Engine", kind: "enum", options: ["copilot", "mock", "openai", "anthropic"] },
  { path: "defaults.maxRounds", section: "Defaults", label: "Max rounds", kind: "number", integer: true, min: 1, max: 20 },
  { path: "defaults.maxExperts", section: "Defaults", label: "Max experts", kind: "number", integer: true, min: 2, max: 8 },
  { path: "defaults.maxWordsPerResponse", section: "Defaults", label: "Max words/response", kind: "number", integer: true, min: 50, max: 2000 },
  { path: "telemetry.enabled", section: "Telemetry", label: "Telemetry enabled", kind: "boolean" },
  { path: "providers.openai.apiKeyEnvVar", section: "Providers", label: "OpenAI API key env var", kind: "string", optional: true },
  { path: "providers.anthropic.apiKeyEnvVar", section: "Providers", label: "Anthropic API key env var", kind: "string", optional: true },
  { path: "expert.recencyHalfLifeDays", section: "Expert", label: "Memory recency half-life (days)", kind: "number", integer: true, min: 1, max: 365 },
  { path: "documents.aiExtraction", section: "Documents", label: "AI extraction", kind: "enum", options: ["off", "ask", "auto"] },
  { path: "documents.maxFileSizeMB", section: "Documents", label: "Max file size (MB)", kind: "number", min: 1, max: 500 },
  { path: "chat.recentTurnCount", section: "Chat", label: "Recent turns kept", kind: "number", integer: true, min: 5, max: 50 },
  { path: "chat.summaryMaxWords", section: "Chat", label: "Summary max words", kind: "number", integer: true, min: 100, max: 2000 },
  { path: "chat.longConversationWarning", section: "Chat", label: "Long-conversation warning", kind: "number", integer: true, min: 50, max: 10000 },
  { path: "conclude.maxTranscriptChars", section: "Conclude", label: "Max transcript chars", kind: "number", min: 1000, max: 1000000 },
  { path: "qualityGate.mode", section: "Quality Gate", label: "Mode", kind: "enum", options: ["off", "warn", "regenerate"] },
  { path: "qualityGate.maxRegenerations", section: "Quality Gate", label: "Max regenerations", kind: "number", integer: true, min: 0, max: 3 },
  { path: "paths.dataHome", section: "Paths", label: "Data home", kind: "string" },
];
```

**`readFieldValue(config, path)`**: walk the dot-path over `config` (guarding non-object/undefined at each step); return the value `String(...)` (booleans → "true"/"false", numbers → String, strings as-is); missing/undefined → `""`.

**`validateField(field, raw)`** (mirror the CLI coercion):
- `string`: `const v = raw.trim();` if `v === "" && !field.optional` → `{ ok:false, error:"Required" }`; reject control chars (`/[\u0000-\u001f]/` → `{ ok:false, error:"No control characters" }`); else `{ ok:true, value:v }`.
- `number` (mirror the CLI's `parseIntegerConfigValue` for integer fields; `Number()` for the non-int `z.number()` fields):
  - if `field.integer` (the fields the CLI routes through `parseIntegerConfigValue`: `defaults.maxRounds/maxExperts/maxWordsPerResponse`, `chat.recentTurnCount/summaryMaxWords/longConversationWarning`, `expert.recencyHalfLifeDays`, `qualityGate.maxRegenerations`): require the trimmed input to match a plain optionally-signed decimal integer (the regex `^[+-]?[0-9]+$`) — this rejects empty/whitespace, hex (`0x2`), exponent (`1e3`), and fractional (`1.0`) forms exactly as the CLI's `parseIntegerConfigValue` does — else `{ ok:false, error:"Must be a whole number" }`; then `const n = Number.parseInt(raw.trim(), 10)`.
  - else (the non-integer numeric fields the CLI coerces with `Number()`: `documents.maxFileSizeMB` and `conclude.maxTranscriptChars`): `const t = raw.trim(); if (t === "") → { ok:false, error:"Must be a number" }` (guard, since `Number("")` is `0`); `const n = Number(t); if (!Number.isFinite(n)) → { ok:false, error:"Must be a number" }`. (Note: `conclude.maxTranscriptChars` is `z.number().int()` in the schema, but the CLI coerces it with `Number()`; mirror the CLI here — a fractional value passes `validateField` and is then rejected by the schema's `.int()` at save time, exactly as in the CLI.)
  - then range: `if (n < field.min! || n > field.max!) → { ok:false, error:`Must be between ${field.min} and ${field.max}` }`; else `{ ok:true, value:n }`.
- `boolean`: accept `true/yes/y/on/1` → true and `false/no/n/off/0` → false (case-insensitive, trimmed); else `{ ok:false, error:"Must be true or false" }`.
- `enum`: `field.options!.includes(raw.trim())` → `{ ok:true, value:raw.trim() }` else `{ ok:false, error:`Must be one of: ${options.join(", ")}` }`.

**`buildSettingsFields(config)`**: `SETTINGS_FIELDS.map((f) => ({ ...f, value: readFieldValue(config, f.path) }))`.

**`createSettingsDataSource(deps)`**: `load: async () => buildSettingsFields(await deps.loadConfig())`; `save: async (changes) => deps.updateConfigFields(changes.map((c) => ({ key: c.path, value: c.value })))`.

- [ ] **Step 1 (test, RED):** cover EVERY branch — `readFieldValue` (nested hit, missing path, boolean/number/string rendering); `validateField` for each kind incl. each failure (empty-required vs optional-empty, control char, **integer field rejecting empty/hex `0x2`/exponent `1e3`/fractional `1.0`** (e.g. `qualityGate.maxRegenerations`), non-integer field (`documents.maxFileSizeMB` AND `conclude.maxTranscriptChars`) rejecting empty + non-finite, out-of-range for both integer and non-integer, bad-boolean, bad-enum) AND each success (incl. a valid fractional accepted by `validateField` for both `documents.maxFileSizeMB` and `conclude.maxTranscriptChars`); `buildSettingsFields` (assert it returns 18 fields with current values from a sample config); `createSettingsDataSource` with fakes (load maps; save forwards `path→key`). Run targeted coverage → 100%. Commit `test(tui): add failing tests for config-settings adapter`.
- [ ] **Step 2 (feat):** implement; targeted coverage 100%; `feat(tui): add config-settings adapter`.

---

## Task 2: `InputCaptureContext` + gate `AppRouter` (PR-B) — test-first

**Why:** When a Settings field is being edited, keystrokes (and `Esc`) must go to the field editor, NOT to `AppRouter`'s global `\`/`?`/`Ctrl-K`/`Esc`/`q` handler (Ink broadcasts to all active `useInput`). A shared **capture** flag gates AppRouter's top-level `useInput`.

**Files:** Create `packages/cli/src/tui/components/InputCaptureProvider.tsx`; Modify `packages/cli/src/tui/router/AppRouter.tsx`; Tests `packages/cli/tests/unit/tui/input-capture.test.tsx` + extend `app-router.test.tsx`.

**Produces:**
```ts
export interface InputCapture { readonly captured: boolean; readonly setCaptured: (v: boolean) => void; }
export function InputCaptureProvider(props: { children: React.ReactNode }): React.ReactElement;
export function useInputCapture(): InputCapture;   // returns { captured:false, setCaptured: noop } if no provider (safe default)
```
- `InputCaptureProvider` holds `useState(false)`; provides `{ captured, setCaptured }`.
- `AppRouter` calls `const { captured } = useInputCapture();` and gates its hook: `useInput((input, key) => { … }, { isActive: mode === "nav" && !captured });` (keep the existing `mode !== "palette"` semantics — combine: active only when `mode === "nav" && !captured`; help/palette already render their own handlers). **Confirm existing AppRouter tests still pass** (when `captured` is false, behavior is unchanged).
- `CouncilTUI` wraps the app in `<InputCaptureProvider>` (around `<AppRouter/>`, inside `MemoryRouter` is fine; or in `index.tsx` around `<CouncilTUI/>` — pick one; the provider must enclose both `AppRouter` and the routed screens so `SettingsScreen` and `AppRouter` share the same context).

- [ ] **Step 1 (test, RED):** (a) `useInputCapture` returns the provided value inside the provider and a safe no-op default outside it; (b) an **AppRouter gating test**: render `CouncilTUI`/`AppRouter` inside the provider with a tiny helper that flips `setCaptured(true)`, then assert a global key no longer fires — e.g. with `captured=true`, pressing `\` does NOT toggle the nav (frame unchanged) and pressing `?` does NOT open help; with `captured=false` the same keys DO fire. Commit `test(tui): add failing tests for input capture gating`.
- [ ] **Step 2 (feat):** implement provider + gate AppRouter + wrap in `CouncilTUI`. Full tui suite green. Commit `feat(tui): gate AppRouter global keys via input-capture context`.

---

## Task 3: `SettingsScreen` render + field navigation (PR-C) — test-first

**Files:** Create `packages/cli/src/tui/screens/SettingsScreen.tsx`; Modify `DataProvider.tsx` (`settings?: SettingsDataSource`), `AppRouter.tsx` (`/settings` → `SettingsScreen`), `index.tsx` (glue); Test `packages/cli/tests/unit/tui/settings-screen.test.tsx` + update `app-router.test.tsx`.

**Behavior (render + navigate; editing is PR-D):**
- `const settings = useData().settings as SettingsDataSource | undefined;` stable empty-loader fallback; `useAsyncResource(load)`; loading/error/loaded states.
- On the loaded state, render fields grouped by `section` (a section header line, then each field `label: value`, value via `toSingleLineDisplay`). Track a `cursor` index over the flat field list; the selected field row is inverse. `↑/k` and `↓/j` and `Tab`/`Shift+Tab` move the cursor (clamped). **Capture input on mount**: `const { setCaptured } = useInputCapture(); useEffect(() => { setCaptured(true); return () => setCaptured(false); }, [setCaptured]);` so the screen owns all keys while active (AppRouter gated).
- `Esc` → `navigate(-1)` (the screen owns Esc now, since AppRouter is gated while captured). `?`-help/`\`-nav are intentionally inactive on Settings (you're in a focused form; Esc exits).
- Footer/legend line: `↑↓ move · Enter edit · Ctrl+S save · Esc back` (static text; the real Footer stays from AppRouter).

- [ ] **Step 1 (test, RED):** wrap in `DataProvider` (+ `InputCaptureProvider` + `MemoryRouter`); fake `settings.load` → a few fields across 2 sections. Assert: section headers + field labels + values render; `↓`/`Tab` moves the inverse selection; `Esc` (REAL-timer wait) navigates back (assert a parent route marker). Add loading + error tests. Commit `test(tui): add failing tests for SettingsScreen render and navigation`.
- [ ] **Step 2 (feat):** implement screen; swap the `/settings` placeholder in `AppRouter`; `DataProvider` gains `settings?`; `index.tsx` builds `settings: createSettingsDataSource({ loadConfig, updateConfigFields })` (`updateConfigFields` from `../config/loader.js`). Update the `app-router.test.tsx` `/settings` test to provide a settings source. Commit `feat(tui): add SettingsScreen with field navigation`.

---

## Task 4: field editing + validation + save (PR-D) — test-first

**Files:** Modify `SettingsScreen.tsx`; Test extend `settings-screen.test.tsx`.

**Behavior:**
- A `mode: "nav" | "edit"` within the screen + a `draft: Map<path,string>` of staged edits + a per-field `error?: string`.
- In `nav` mode: `Enter` on the selected field enters `edit` mode. `Ctrl+S` saves (below). `Esc` → if there are staged changes, discard them and stay (or just `navigate(-1)`; keep it simple: `Esc` in nav → `navigate(-1)`).
- In `edit` mode, by field `kind`:
  - `string`/`number`: render an `ink-text-input` (`<TextInput value={draftValue} onChange={setDraftValue} onSubmit={commit} />`) seeded from the current/draft value. `Enter` (`onSubmit`) → `validateField`; on `ok` stage `draft.set(path, raw)` + clear error + back to `nav`; on error set the field `error` and STAY in edit. `Esc` cancels edit (back to `nav`, draft for this field unchanged).
  - `boolean`: `Enter`/`space` toggles the staged value (`"true"`↔"false"`) and returns to `nav` (no text input).
  - `enum`: `←/→` cycle through `options` (staged), `Enter` confirms → `nav`, `Esc` cancels.
  - Show the field `error` (if any) in `theme.error` under the row.
- **Dirty indicator**: mark changed fields (draft value ≠ original) e.g. with a `*` prefix; show a footer hint when `draft` non-empty.
- **Save (`Ctrl+S`)**: build `changes` = for each dirty field, `validateField(field, draftRaw)`; if ANY invalid → set that field's error, focus it, do NOT save; if all valid → `await settings.save(validatedChanges)`; on success clear the draft (reload or update originals) + show a transient "Saved" message; on a thrown error (the schema re-validation in `updateConfigFields`) → show the error message (sanitized) and keep the draft.
- The screen continues to **capture input** in both modes (already set in PR-C); the `ink-text-input` receives keys because AppRouter is gated.

- [ ] **Step 1 (test, RED):** cover — entering edit on a number field, typing an out-of-range value, Enter → inline error shown + still editing; typing a valid value, Enter → staged (dirty `*`), back to nav; boolean toggle; enum cycle with `←/→`; `Ctrl+S` with a valid draft calls `settings.save` with the coerced `{path,value}` changes (assert via a spy/fake) and shows "Saved"; `Ctrl+S` with an invalid draft does NOT call save and shows the error; `Esc` in edit cancels without staging. Use REAL-timer waits for lone `Esc`. Commit `test(tui): add failing tests for SettingsScreen editing and save`.
- [ ] **Step 2 (feat):** implement; full suite green; `feat(tui): add SettingsScreen editing, validation, and save`.

> Keep any non-trivial coercion/validation logic in the tested `config-settings.ts` (`validateField`) — the screen only orchestrates modes + calls `validateField`/`save`. `ink-text-input` was validated under Ink 7 in M0; if its keystroke handling needs `isActive`, gate it on `mode === "edit"`.

## Self-Review
1. **Spec coverage (design §4.8 / story epic B):** change default model/engine/rounds/experts/words → Task 1 fields + Task 4; toggle telemetry, tune chat/conclude/documents/expert/qualityGate → fields; provider env-var NAME → `providers.*.apiKeyEnvVar` field; inline validation before save → `validateField` + Task 4. Arrays (`supportedFormats`) intentionally out of M3 scope (note in PR descriptions).
2. **Placeholder scan:** none — adapter fully coded; screen behavior concrete.
3. **Type consistency:** `SettingsFieldDescriptor`/`SettingsFieldState`/`ValidateResult`/`SettingsDataSource` defined once; `save` takes `{path,value}` mapped to `{key,value}` for `updateConfigFields`.

## Risks & Mitigations
| Risk | Mitigation |
|------|-----------|
| Editing keys double-dispatch with AppRouter global keys | Input-capture context (Task 2) gates AppRouter while Settings is active; tested. |
| `updateConfigFields` throws on schema-invalid input | `validateField` pre-validates per field (mirrors schema); Save also catches the thrown formatted error and shows it. |
| `ink-text-input` behavior under Ink 7 | Validated in M0; gate its activity on `mode==="edit"`; if problematic, fall back to the M0 `MultilineInput` single-line. |
| Settings as screen vs design's "overlay" | M3 ships a route-based `SettingsScreen` (consistent with M2); the floating-overlay treatment is deferred to a11y polish (9.9). Note in the PR. |
| Arrays (`supportedFormats`) not editable | Out of scope for M3; document; a later PR can add list editing. |

## Execution Handoff
Plan saved to `docs/superpowers/plans/2026-06-23-tui-m3-settings-plan.md`. Execute via **subagent-driven-development**: PR-A and PR-B can run in parallel (independent); PR-C after both; PR-D after PR-C. One delegated implementer per PR (stops at "PR opened"); the parent invokes Sentinel per PR and merges on APPROVED/CONDITIONAL.
