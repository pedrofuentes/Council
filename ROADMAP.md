# Roadmap — Council

> Detailed implementation plan. Each item specifies files, interfaces, dependencies, and acceptance criteria so that any agent (or developer) can implement without ambiguity.

## Current Phase

**Phase 1: Foundation** — Goal: `council convene "topic"` produces a useful multi-expert discussion in the terminal.

---

## Phase 1: Foundation

### 1.1 Project Scaffolding

**Files to create:**
```
package.json
tsconfig.json
tsup.config.ts
vitest.config.ts
.gitignore
.eslintrc.cjs (or eslint.config.mjs)
.prettierrc
LICENSE
src/index.ts              (empty, programmatic API entry)
src/bin/council.ts         (CLI entry: #!/usr/bin/env node)
```

**package.json spec:**
```json
{
  "name": "@council/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": { "council": "./dist/bin/council.js" },
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src/ tests/",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write ."
  }
}
```

**Key dependencies:**
- `commander` (CLI parsing)
- `ink` + `ink-spinner` + `react` (terminal UI)
- `@libsql/client` + `@libsql/kysely-libsql` + `kysely` (persistence — pure WASM, see ADR-005)
- `zod` (schema validation)
- `yaml` (config parsing)
- `ulid` (ID generation)
- `chalk` (colors for plain renderer)
- `pino` (logging)
- `@github/copilot-sdk` (AI engine)

**Dev dependencies:**
- `typescript` ^5.7
- `tsup`
- `vitest`
- `eslint` + `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser`
- `prettier`
- `@types/react`

**tsconfig.json spec:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

**ESLint rule (critical):** Add `no-restricted-imports` to ban `@github/copilot-sdk` from all files except `src/engine/copilot/*.ts`.

**.gitignore must include:** `node_modules/`, `dist/`, `.worktrees/`, `*.db`, `*.db-wal`, `*.db-shm`, `.council/`

**Acceptance criteria:**
- `pnpm install` succeeds
- `pnpm build` produces `dist/` with working ESM output
- `pnpm test` runs (0 tests, 0 failures)
- `pnpm lint` passes
- `pnpm typecheck` passes
- `node dist/bin/council.js --version` prints `0.1.0`

---

### 1.2 CouncilEngine Interface

**Files to create:**
```
src/engine/index.ts
src/engine/types.ts
```

**`src/engine/types.ts` — Domain types (NOT SDK types):**
```typescript
export interface ExpertSpec {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly model: string;
  readonly systemMessage: string;
  readonly reasoningEffort?: "low" | "medium" | "high";
}

export interface SendOptions {
  readonly prompt: string;
  readonly expertId: string;
}

export interface EngineResponse {
  readonly content: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly latencyMs: number;
}

export type EngineEvent =
  | { kind: "message.delta"; expertId: string; text: string }
  | { kind: "message.complete"; expertId: string; response: EngineResponse }
  | { kind: "error"; expertId: string; error: Error; recoverable: boolean };
```

**`src/engine/index.ts` — Interface:**
```typescript
export interface CouncilEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  addExpert(spec: ExpertSpec): Promise<void>;
  removeExpert(expertId: string): Promise<void>;
  send(options: SendOptions): AsyncIterable<EngineEvent>;
  listModels(): Promise<string[]>;
}
```

**Acceptance criteria:**
- Types compile with `tsc --noEmit`
- No imports from `@github/copilot-sdk`
- Interface is exported from `src/engine/index.ts`

---

### 1.3 MockEngine

**Files to create:**
```
src/engine/mock/mock-engine.ts
tests/unit/engine/mock-engine.test.ts
```

**Behavior:**
- Implements `CouncilEngine` interface
- Accepts a `Map<string, string>` of expertId → response text
- `send()` yields `message.delta` events (chunked by sentence) then `message.complete`
- Simulates configurable latency (default 0ms for tests)
- `listModels()` returns `["mock-model"]`
- Throws on `send()` to unknown expertId

**Acceptance criteria:**
- Unit tests verify: add expert → send → receive events in correct order
- Unit tests verify: error on unknown expert
- Unit tests verify: streaming chunks arrive as `message.delta` before `message.complete`

---

### 1.4 Copilot SDK Adapter

**Files to create:**
```
src/engine/copilot/adapter.ts
src/engine/copilot/session-pool.ts
src/engine/copilot/permissions.ts
tests/integration/engine/copilot-adapter.test.ts  (gated behind COUNCIL_INTEGRATION_TESTS=true)
```

**`src/engine/copilot/permissions.ts`:**
```typescript
import type { PermissionHandler } from "@github/copilot-sdk";
export const denyAll: PermissionHandler = async () => ({ decision: "deny" });
export function scopedAllow(allowed: Set<string>): PermissionHandler {
  return async (req) => allowed.has(req.toolName)
    ? { decision: "allow" }
    : { decision: "deny" };
}
```

**`src/engine/copilot/session-pool.ts`:**
- `ExpertSessionPool` class
- One `CopilotClient` instance, N `CopilotSession` instances keyed by expertId
- `acquire(spec)` → creates or resumes session
- `disposeAll()` → disconnects all sessions
- Uses `copilotHome` scoped per panel: `~/.council/panels/<panelId>/copilot/`
- Enables `infiniteSessions: { enabled: true }` on all sessions

**`src/engine/copilot/adapter.ts`:**
- Implements `CouncilEngine` interface
- `start()` → `new CopilotClient()` + `client.start()`
- `stop()` → pool.disposeAll() + `client.stop()`
- `addExpert()` → pool.acquire(spec)
- `send()` → session.send() + translates SDK events to `EngineEvent`
- `listModels()` → returns known model list (hardcoded initially)
- **This is the ONLY file that imports `@github/copilot-sdk`**

**Acceptance criteria:**
- ESLint `no-restricted-imports` rule passes (no SDK imports elsewhere)
- MockEngine tests pass (adapter shares same interface)
- Integration test (when enabled): creates client, sends prompt, receives response

---

### 1.5 Configuration System

**Files to create:**
```
src/config/schema.ts
src/config/loader.ts
tests/unit/config/loader.test.ts
```

**Config location:** `~/.council/config.yaml`

**`src/config/schema.ts` — Zod schemas:**
```typescript
import { z } from "zod";

export const ConfigSchema = z.object({
  defaults: z.object({
    model: z.string().default("claude-sonnet-4-20250514"),
    maxRounds: z.number().int().min(1).max(20).default(4),
    maxExperts: z.number().int().min(2).max(8).default(3),
    maxWordsPerResponse: z.number().int().min(50).max(2000).default(250),
  }).default({}),
  telemetry: z.object({
    enabled: z.boolean().default(false),
  }).default({}),
});

export type CouncilConfig = z.infer<typeof ConfigSchema>;
```

**`src/config/loader.ts`:**
- `loadConfig()` → reads `~/.council/config.yaml`, parses YAML, validates with Zod, returns `CouncilConfig`
- Creates default config file if missing
- Merges CLI flags over file config (flags win)
- Exposes `getCouncilHome()` → `~/.council/` (uses `os.homedir()`)

**Acceptance criteria:**
- Missing config file → creates default, returns valid config
- Invalid YAML → throws descriptive error with path
- Partial config → merges with defaults correctly
- Config values are accessible via typed interface

---

### 1.6 Expert System

**Files to create:**
```
src/core/expert.ts
src/core/prompt-builder.ts
tests/unit/core/expert.test.ts
tests/unit/core/prompt-builder.test.ts
```

**`src/core/expert.ts` — Expert entity:**
```typescript
export interface ExpertDefinition {
  readonly slug: string;
  readonly displayName: string;
  readonly role: string;
  readonly model?: string;  // override default
  readonly expertise: {
    readonly weightedEvidence: string[];  // ordered by priority
    readonly referenceCases: string[];
    readonly notExpertIn: string[];
  };
  readonly epistemicStance: string;
  readonly debateProtocol?: string;  // override default anti-sycophancy
  readonly outputContract?: string;
  readonly forbiddenMoves?: string[];
  readonly personality?: string;  // thin layer, last 5% of value
}
```

**`src/core/prompt-builder.ts` — 8-section system prompt generator:**
Builds the system message from `ExpertDefinition` + injected memory:
```
[1] IDENTITY          — from role + displayName + personality
[2] EXPERTISE PRIOR   — from expertise.weightedEvidence + referenceCases
[3] EPISTEMIC STANCE  — from epistemicStance
[4] DEBATE PROTOCOL   — from debateProtocol (or default anti-sycophancy template)
[5] OUTPUT CONTRACT   — from outputContract (or default: structured, specific, falsifiable)
[6] FORBIDDEN MOVES   — from forbiddenMoves + default forbidden phrases list
[7] MEMORY            — injected at runtime (empty in v0)
[8] CURRENT TASK      — injected per-turn by moderator
```

**Default forbidden phrases (hardcoded):**
```
"Great point", "I agree with", "Building on X's point",
"holistic", "synergy", "leverage" (as verb), "robust", "best practices"
```

**Default debate protocol (hardcoded):**
```
Before supporting any prior speaker, identify at least one of:
(a) A specific claim of theirs you find weak, with counter-argument
(b) A consideration they omitted that materially changes the answer
(c) A scenario where their recommendation fails
If after honest effort you find none, say: "I have stress-tested [Expert]'s
position and cannot find a material weakness."
```

**Acceptance criteria:**
- `buildSystemPrompt(definition, memory, task)` → produces string with all 8 sections
- All 8 sections are present and correctly ordered
- Default forbidden phrases are always included (even if definition has custom ones)
- Default debate protocol is used when definition doesn't override
- Memory section is empty string when no memory provided

---

### 1.7 SQLite Schema

> **Backend updated 2026-05-07 (ADR-005):** uses `@libsql/client` (pure WASM) + `@libsql/kysely-libsql` instead of `better-sqlite3`. No native build, works on every Node version.

**Files to create:**
```
src/memory/db.ts
src/memory/migrations/001_init.sql
src/memory/migrations/runner.ts
src/memory/repositories/panels.ts
src/memory/repositories/experts.ts
src/memory/repositories/turns.ts
tests/unit/memory/repositories.test.ts
```

**`src/memory/db.ts` — sketch:**
```typescript
import { createClient } from "@libsql/client";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { Kysely } from "kysely";

export interface Database {
  panels: PanelTable;
  experts: ExpertTable;
  debates: DebateTable;
  turns: TurnTable;
  schema_version: { version: number; applied_at: string };
}

export async function createDatabase(path: string): Promise<Kysely<Database>> {
  const url = path === ":memory:" ? ":memory:" : `file:${path}`;
  const client = createClient({ url });
  const db = new Kysely<Database>({ dialect: new LibsqlDialect({ client }) });
  await runMigrations(db);
  return db;
}
```

**Schema (libsql/SQLite — see `docs/ARCHITECTURE.md` and DECISIONS ADR-002 + ADR-005):**
- `panels` (id TEXT PK ULID, name, topic, created_at TEXT ISO, updated_at TEXT ISO, copilot_home TEXT, config_json TEXT)
- `experts` (id TEXT PK ULID, panel_id FK, slug TEXT, display_name TEXT, model TEXT, system_message TEXT, copilot_session_id TEXT NULL, created_at TEXT ISO; UNIQUE panel_id+slug)
- `debates` (id TEXT PK ULID, panel_id FK, prompt TEXT, status TEXT, moderator TEXT, started_at TEXT ISO, ended_at TEXT ISO NULL, cost_estimate INTEGER)
- `turns` (id TEXT PK ULID, debate_id FK, round INTEGER, seq INTEGER, speaker_kind TEXT, expert_id FK NULL, content TEXT, tokens_in INTEGER NULL, tokens_out INTEGER NULL, latency_ms INTEGER NULL, created_at TEXT ISO; INDEX on debate_id+round+seq)
- `turns_fts` FTS5 virtual table on turns.content
- `schema_version` (version INTEGER PK, applied_at TEXT ISO)

**Schema notes (changed from original spec):**
- Timestamps stored as ISO 8601 strings (libsql/SQLite default), not epoch ms — clearer to inspect, identical lexicographic ordering
- WAL mode is N/A for libsql in WASM mode (different journaling); the equivalent durability lives inside libsql

**Repository pattern (Kysely-typed):**
- `PanelRepository`: create, findById, findAll, update, delete
- `ExpertRepository`: create, findByPanelId, findById, update, delete
- `TurnRepository`: create, findByDebateId, search (FTS5 MATCH)

**Acceptance criteria:**
- `createDatabase(":memory:")` resolves to a typed Kysely instance with all tables
- `createDatabase("/path/to/file.db")` creates the file if missing
- CRUD operations work for all repositories
- FTS5 search returns matching turns (libsql ships FTS5)
- Migrations run idempotently (running twice = no error, schema_version rows do not duplicate)
- `pnpm install` succeeds with NO native build (verified by repo CI when added)

---

### 1.8 Debate Orchestrator

**Files to create:**
```
src/core/debate.ts
src/core/types.ts
tests/unit/core/debate.test.ts
```

**`src/core/types.ts` — DebateEvent union type:**
```typescript
export type DebateEvent =
  | { kind: "panel.assembled"; experts: ReadonlyArray<{ slug: string; displayName: string; model: string }> }
  | { kind: "round.start"; round: number }
  | { kind: "turn.start"; expertSlug: string; round: number; seq: number }
  | { kind: "turn.delta"; expertSlug: string; text: string }
  | { kind: "turn.end"; expertSlug: string; turnId: string; content: string }
  | { kind: "round.end"; round: number; summary?: string }
  | { kind: "debate.end"; reason: "completed" | "consensus" | "aborted" | "limit" }
  | { kind: "cost.update"; premiumRequests: number; estimatedTotal: number }
  | { kind: "error"; expertSlug?: string; error: Error; recoverable: boolean };
```

**`src/core/debate.ts` — Debate class:**
```typescript
export class Debate {
  constructor(
    private engine: CouncilEngine,
    private experts: ExpertDefinition[],
    private config: DebateConfig,
  ) {}

  async *run(prompt: string): AsyncIterable<DebateEvent> {
    // 1. Yield panel.assembled
    // 2. For each round (up to config.maxRounds):
    //    a. Yield round.start
    //    b. For each expert (sequential, with visibility of prior turns in this round):
    //       - Build prompt with: expert system message + conversation context + current round context
    //       - Call engine.send()
    //       - Yield turn.start, turn.delta (streaming), turn.end
    //    c. Yield round.end
    // 3. Yield debate.end
  }
}
```

**DebateConfig:**
```typescript
export interface DebateConfig {
  readonly maxRounds: number;
  readonly maxWordsPerResponse: number;
  readonly mode: "freeform" | "structured";
  readonly moderatorModel?: string;
}
```

**Visibility rule (freeform mode):** Each expert sees all prior experts' responses from the current round + a summary of previous rounds (empty for round 0).

**Acceptance criteria (using MockEngine):**
- Debate with 2 experts, 2 rounds → produces correct event sequence: `panel.assembled → round.start(0) → turn.start → turn.delta* → turn.end → turn.start → turn.delta* → turn.end → round.end(0) → round.start(1) → ... → debate.end`
- Events are ordered correctly (no interleaving between experts)
- `turn.end` content matches accumulated `turn.delta` text
- `debate.end` fires with reason `"completed"` after maxRounds
- Cost updates are emitted after each turn

---

### 1.9 Pluggable Renderers

**Files to create:**
```
src/cli/renderers/types.ts
src/cli/renderers/plain.ts
src/cli/renderers/json.ts
src/cli/renderers/ink/             (deferred to Phase 3 — use plain for now)
tests/unit/cli/renderers/plain.test.ts
tests/unit/cli/renderers/json.test.ts
```

**`src/cli/renderers/types.ts`:**
```typescript
export interface Renderer {
  render(events: AsyncIterable<DebateEvent>): Promise<void>;
}
```

**`src/cli/renderers/plain.ts` — PlainRenderer:**
- Writes to `process.stdout`
- `panel.assembled` → prints expert list with models
- `turn.start` → prints `\n[ExpertName] (model):\n`
- `turn.delta` → writes text chunk immediately (streaming feel)
- `round.end` → prints separator
- `debate.end` → prints `\n--- Debate complete (reason) ---\n`
- `cost.update` → prints `[Cost: N premium requests]`
- `error` → prints to stderr in red

**`src/cli/renderers/json.ts` — JsonRenderer:**
- Writes one NDJSON line per event to stdout
- Each line is `JSON.stringify(event) + "\n"`
- No formatting, no colors

**Renderer selection logic (in `src/bin/council.ts`):**
```typescript
function selectRenderer(flags: { format?: string }): Renderer {
  if (flags.format === "json") return new JsonRenderer();
  // Future: if (process.stdout.isTTY) return new InkRenderer();
  return new PlainRenderer();
}
```

**Acceptance criteria:**
- PlainRenderer prints expert name before each response
- PlainRenderer streams turn.delta chunks (not buffered)
- JsonRenderer produces valid NDJSON (one JSON object per line)
- Renderer selection works based on --format flag

---

### 1.10 Core CLI Commands

**Files to create:**
```
src/bin/council.ts             (main entry point)
src/cli/commands/convene.ts
src/cli/commands/ask.ts
src/cli/commands/panels.ts
src/cli/commands/doctor.ts
tests/unit/cli/commands/convene.test.ts
```

**`src/bin/council.ts` — CLI entry:**
```typescript
#!/usr/bin/env node
import { Command } from "commander";
const program = new Command()
  .name("council")
  .description("Persistent AI expert panels for deliberation and decision-making")
  .version("0.1.0");

// Register subcommands
program.addCommand(conveneCommand);
program.addCommand(askCommand);
program.addCommand(panelsCommand);
program.addCommand(doctorCommand);

program.parse();
```

**`council convene <topic>` command:**
- Options: `--template <name>`, `--experts <list>`, `--model <default>`, `--rounds <n>`, `--format <json|plain>`, `--estimate`
- Flow:
  1. Load config
  2. If `--template`: load panel YAML from `panels/` directory
  3. If `--experts`: parse comma-separated expert slugs, create ad-hoc definitions
  4. Else: use default panel (general-brainstorm with 3 experts)
  5. If `--estimate`: print cost estimate and exit
  6. Create panel in SQLite
  7. Initialize engine + add experts
  8. Create Debate, call `debate.run(topic)`
  9. Pipe events through selected renderer

**`council ask <question>` command:**
- Options: `--expert <slug>`, `--format`
- Requires active panel (most recent, or `--panel <id>`)
- If `--expert`: sends question to single expert only
- Else: sends to full panel (continues debate)

**`council panels` command:**
- Lists all panels from SQLite (id, name, topic, expert count, last activity)

**`council doctor` command:**
- Checks: Node version ≥20, pnpm available, Copilot SDK importable, Copilot auth status (try `client.start()` + `client.ping()`), `~/.council/` writeable, disk space
- Prints ✅/❌ per check

**Acceptance criteria:**
- `council --version` prints version
- `council --help` shows all commands
- `council convene "test topic"` (with MockEngine) produces debate output
- `council panels` lists created panels
- `council doctor` runs all checks and reports status

---

### 1.11 Built-in Panel Templates

**Files to create:**
```
panels/architecture-review.yaml
panels/startup-validation.yaml
panels/code-review.yaml
panels/incident-postmortem.yaml
panels/career-coaching.yaml
src/core/template-loader.ts
tests/unit/core/template-loader.test.ts
```

**Panel YAML schema (Zod-validated in `src/config/schema.ts`):**
```yaml
name: architecture-review
description: "Multi-perspective review of architecture decisions"
defaults:
  mode: freeform
  maxRounds: 4
experts:
  - slug: cto
    displayName: "Dahlia Renner (CTO)"
    role: "Skeptical CTO with 20 years of production systems experience"
    model: claude-sonnet-4-20250514
    expertise:
      weightedEvidence:
        - "Production incident post-mortems"
        - "Operational metrics (p99 latency, error budgets, on-call load)"
        - "Team capacity and skill distribution"
        - "Vendor/tool maturity (years in prod at scale)"
        - "Architectural elegance — LAST, tiebreaker only"
      referenceCases:
        - "Premature microservices split: teams under 30 engineers that split early re-consolidate within 18 months"
        - "Distributed monolith: services sharing a database are not independently deployable"
        - "Conway's tax: every service boundary that doesn't match a team boundary is a coordination tax"
      notExpertIn: ["frontend UX", "ML/data science", "GTM strategy"]
    epistemicStance: >
      You have been burned by elegant architectures the team couldn't operate.
      You would rather ship a boring monolith that runs for five years than a
      beautiful mesh that takes the site down at 3am every Thursday.
  # ... additional experts (Staff Engineer, SRE, Product Manager)
```

**Acceptance criteria:**
- All 5 YAML files parse successfully with Zod schema
- `loadTemplate("architecture-review")` returns typed panel definition
- Unknown template name → descriptive error
- Each template has 3-4 experts with distinct expertise priors

---

### 1.12 `council doctor` Command

(Covered in 1.10 — the command spec is there. This item tracks the implementation separately since it's standalone.)

**Checks to implement:**
1. Node.js version ≥ 20
2. `~/.council/` directory exists and is writable (create if missing)
3. SQLite database can be opened
4. `@github/copilot-sdk` can be imported
5. Copilot authentication: try `client.start()` + `client.stop()` — catch auth errors
6. Available disk space > 100MB

**Output format:**
```
Council Doctor
═════════════════════════════════
✅ Node.js v22.1.0 (≥20 required)
✅ Council home: ~/.council/
✅ Database: OK
✅ Copilot SDK: v0.3.1
❌ Copilot auth: Not authenticated
   → Run: npx @github/copilot auth login
✅ Disk space: 45.2 GB available
```

---

### 1.13 Cost Estimation

**Files to create:**
```
src/core/cost.ts
tests/unit/core/cost.test.ts
```

**`src/core/cost.ts`:**
```typescript
export interface CostEstimate {
  readonly premiumRequests: number;
  readonly breakdown: ReadonlyArray<{ phase: string; count: number }>;
}

export function estimateDebateCost(config: DebateConfig, expertCount: number): CostEstimate {
  // Each expert turn = 1 premium request
  // Each moderator summary = 1 premium request (if moderator enabled)
  // Formula: expertCount × maxRounds + (maxRounds moderator summaries)
  const expertRequests = expertCount * config.maxRounds;
  const moderatorRequests = config.maxRounds;  // one summary per round
  return {
    premiumRequests: expertRequests + moderatorRequests,
    breakdown: [
      { phase: "Expert turns", count: expertRequests },
      { phase: "Moderator summaries", count: moderatorRequests },
    ],
  };
}
```

**Acceptance criteria:**
- 3 experts × 4 rounds → 12 expert + 4 moderator = 16 premium requests
- `--estimate` flag prints cost without running debate
- Cost events are emitted during debate via `cost.update` DebateEvent

---

## Phase 2: Deliberation Quality

### 2.1 Individual Expert Chat
- `council ask --expert <slug> "question"` sends to one expert only
- Uses existing expert session from pool
- Response is direct (no panel/round structure)

### 2.2 Structured Debate Engine
- Add `mode: "structured"` to DebateConfig
- Rounds: Opening Statement → Cross-examination (2 questions per expert pair) → Rebuttal → Synthesis
- Per-round prompt templates in `src/core/moderator/prompts/`
- Cross-examination: moderator pairs experts and generates targeted questions

### 2.3 Pluggable Moderator Strategies
- `ModeratorStrategy` interface in `src/core/moderator/index.ts`
- Strategies: `round-robin-parallel`, `sequential-with-visibility`, `socratic`, `devils-advocate`, `consensus-check`
- Each strategy controls: turn order, visibility scope, termination condition

### 2.4 Anti-sycophancy Enforcement
- Quality gate runs on every expert response
- Checks: forbidden phrase presence, disagreement budget met, specificity score, non-fungibility
- On failure: regenerate with hint ("Your response contained forbidden phrases. Rewrite without: ...")
- Max 2 regeneration attempts, then accept with warning

### 2.5 Panel Auto-composition
- Meta-prompt analyzes topic → suggests expert panel (roles, models, expected disagreements)
- Output: JSON panel spec compatible with panel YAML schema
- Can refuse for trivial/factual questions
- User can accept, modify, or override

### 2.6 Context Window Management
- Visibility scoping: each expert sees only relevant prior turns
- Rolling summaries: moderator produces 3-5 sentence round summary
- Token budgets: configurable cap per expert per turn
- Leverage `infiniteSessions` for automatic compaction

### 2.7 `council conclude` Command
- Signature interaction: produces decision matrix
- Output: consensus points, unresolved tensions, recommendation
- Formats: plain text, markdown, JSON
- Can be called mid-debate or at end

---

## Phase 3: Persistence & Polish

### 3.1 Persistent Expert Memory
- Per-expert: positions taken, updated priors, unresolved questions
- Stored in SQLite as structured JSON per expert
- Injected into section [7] of system prompt as terse bulleted log

### 3.2 Session Resume
- `council resume` lists past panels, user picks one
- Loads panel + experts from SQLite
- Resumes Copilot sessions via `resumeSession(copilotSessionId)`
- Restores orchestration state from SQLite

### 3.3 Human-as-expert
- `council convene --human "Product Lead"` adds a human expert slot
- Human types responses when it's their turn
- Same turn structure (round, seq, speaker_kind = "human")

### 3.4 Rich Ink Terminal UI
- `src/cli/renderers/ink/` — React + Ink components
- Expert color coding, streaming text, progress spinner
- Interactive panel picker for `council resume`

### 3.5 Memory Inspection CLI ✅ (shipped in PR #178)
- `council memory list` — per-panel summary (expert/debate/turn counts, last activity)
- `council memory inspect <panel>` — detailed panel + expert view (system prompt preview)
- `council memory reset <panel>` — destructive cleanup (requires `--yes`; supports `--hard` and `--expert <slug>`)
- `--ephemeral` flag for sensitive conversations (no persistence) — **deferred**, needs orchestrator awareness

### 3.6 Export System
- `council export <panel> --format markdown|json|adr`
- Markdown: formatted transcript with expert attribution
- JSON: NDJSON of all DebateEvents
- ADR: Decision Record format (problem → options → positions → synthesis)

### 3.7 Error Resilience
- Retry 2× on single expert failure (exponential backoff: 250ms, 1s)
- Continue debate without failed expert
- Persist state as "paused" on client drop (resumable)
- Model fallback per expert config

---

## Phase 4: Growth & Ecosystem

### 4.1 `gh` CLI Extension
### 4.2 GitHub Action
### 4.3 Opt-in Telemetry
### 4.4 Direct Provider APIs

---

## Key Milestones

| Milestone | Phase | Status |
|-----------|-------|--------|
| `pnpm build && pnpm test` pass | Phase 1.1 | pending |
| `council convene "topic"` produces multi-expert debate | Phase 1.10 | pending |
| Individual expert chat works | Phase 2.1 | pending |
| Structured debate with synthesis | Phase 2.2 | pending |
| Experts remember across sessions | Phase 3.1 | pending |
| Published to npm as `@council/cli` | Phase 4 | pending |
| Show HN launch | Phase 4 | pending |
