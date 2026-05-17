# Testing Strategy

> Extended testing context for AI agents. Referenced from AGENTS.md.
> **The TDD mandate (tests before implementation) is enforced in AGENTS.md and verified by Sentinel.**
> This document covers the details of HOW to test.

---

## Test Types

| Type | Purpose | Location | Runner |
|------|---------|----------|--------|
| Unit | Core logic, pure functions, isolated components | `tests/unit/` or `*.test.ts` | Vitest |
| Integration | Cross-component interactions, engine integration | `tests/integration/` | Vitest |
| E2E | CLI command flows end-to-end | `tests/e2e/` (94 tests across 10 files) | Vitest (in-process) |
| Security | Prompt injection defense verification, hostile payload tests | `tests/security/` | Vitest |

## Coverage Requirements

- **New code**: 80% diff coverage required (lines added/modified in the PR)
- **Project-wide coverage**: must never decrease from the previous merge baseline
- **Critical paths**: 100% coverage required (engine interface, debate orchestrator, moderator strategies)
- **Run coverage**: `pnpm test --coverage`
- **Sentinel verifies coverage thresholds on every PR**

## Test-Only PRs

PRs that only add tests to existing (untested) code use commit type `test(scope)` and are exempt from test-first choreography ordering (there is no `feat`/`fix` to follow). Sentinel verifies the tests are meaningful and pass.

## Testing Patterns

### MockEngine for Unit Tests
All unit tests MUST use MockEngine — never the real Copilot SDK. This ensures:
- Tests are free (no premium requests consumed)
- Tests are deterministic (same input → same output)
- Tests are fast (no network, no subprocess)

```typescript
import { MockEngine } from '../src/engine/mock/mock-engine.js';

// MockEngine returns deterministic responses keyed by prompt content
const engine = new MockEngine({
  responses: {
    'architecture-review': 'I recommend a modular monolith...',
    'security-review': 'The main concern is input validation...',
  },
});

describe('Debate', () => {
  it('should produce DebateEvents for each expert turn', async () => {
    const debate = new Debate(engine, panel);
    const events: DebateEvent[] = [];
    for await (const event of debate.run('Should we use microservices?')) {
      events.push(event);
    }
    expect(events.some(e => e.kind === 'turn.end')).toBe(true);
  });
});
```

### Integration Tests with Real SDK
Integration tests that use the real Copilot SDK are:
- Gated behind `COUNCIL_INTEGRATION_TESTS=true` env var
- Skipped in CI by default (costs money)
- Run manually before major releases
- Located in `tests/integration/`

### E2E Tests — Command-Level Verification
E2E tests verify all 12 CLI commands end-to-end using in-process execution with isolated test environments. The suite consists of **94 tests across 10 test files** covering every user-facing workflow.

**Infrastructure** (`tests/e2e/helpers.ts`):
- `createE2EContext()` / `cleanupE2EContext()` — isolated temp directories for `COUNCIL_HOME` and `COUNCIL_DATA_HOME`
- `captureOutput()` — captures stdout/stderr for assertion
- `makeMockEngineFactory()` — provides deterministic MockEngine instances
- `seedCompletedDebate()` — sets up realistic test data (panel, debate, turns)
- `openTestDb()` — creates isolated SQLite database instances

**Test execution pattern**:
```typescript
import { buildConveneCommand } from '../../src/cli/commands/convene.js';
import {
  createE2EContext,
  cleanupE2EContext,
  captureOutput,
  makeMockEngineFactory,
} from './helpers.js';

const ctx = await createE2EContext();
const { write, stdout } = captureOutput();
const mockEngineFactory = makeMockEngineFactory();

// Execute command in-process (no subprocess)
await buildConveneCommand({ write, engineFactory: mockEngineFactory })
  .parseAsync(['debate', 'Test topic', '--panel', 'my-panel'], { from: 'user' });

expect(stdout()).toContain('expected output');
await cleanupE2EContext(ctx);
```

**Test coverage** (10 files):
- `debate-lifecycle.test.ts` (17 tests) — convene, resume, export, conclude, sessions
- `error-paths.test.ts` (15 tests) — error conditions across all commands
- `memory-management.test.ts` (11 tests) — memory list/inspect/reset
- `expert-panel-crud.test.ts` (10 tests) — expert/panel library CRUD operations
- `chat-lifecycle.test.ts` (8 tests) — persistent chat system
- `config-and-migration.test.ts` (8 tests) — config loading, template migration
- `output-formats.test.ts` (7 tests) — JSON/plain/markdown/ADR format correctness
- `ask-command.test.ts` (7 tests) — one-shot ask workflow
- `document-intelligence.test.ts` (6 tests) — document processing pipeline
- `doctor-diagnostics.test.ts` (5 tests) — diagnostics command

**Why in-process execution (not subprocess)**:
- Faster — no Node.js spawn overhead
- Deterministic — MockEngine ensures consistent responses, no network
- Debuggable — direct stack traces, no cross-process boundary
- Free — zero premium requests consumed

### Test Naming Convention
```typescript
describe('ModuleName', () => {
  it('should {{expected behavior}} when {{condition}}', () => {
    // Arrange → Act → Assert
  });
});
```

### What Must Be Tested
- All public API functions
- Error paths and edge cases (not just happy paths)
- State transitions (debate rounds, expert turns)
- Input validation (panel YAML, config YAML)
- DebateEvent stream sequences
- Moderator strategy decisions

### What Should NOT Be Tested
- Copilot SDK internals
- SQLite query planner behavior
- Ink rendering details (test the data, not the pixels)
- Implementation details (test behavior, not structure)

### Security Tests

Red-team payload tests live in `tests/security/` and verify the layered prompt-injection defense (see [ARCHITECTURE.md §Security](./ARCHITECTURE.md#security-prompt-injection-defense) and ADR-012).

- **What they verify**: structural sanitisation (`sanitizePromptField` / `sanitizePromptBlock` / `sanitizeFenced` / `escapeFenceContent`), XML-style fencing of untrusted content, attribute-context escaping, length caps, and Zod schema rejection of `[NN]` markers — all against six categories of hostile payloads: section-marker spoofing, fence-breaking, cross-expert injection, memory poisoning, Unicode bypass (NEL / U+2028 / U+2029 / bidi / zero-width), and context stuffing.
- **No LLM calls** — tests exercise the pure sanitisation functions and prompt builders directly. They never invoke the engine (real or mock), so they run free, fast, and on every PR in the standard Vitest suite.
- **Deterministic, not fuzzing** — payloads are hardcoded so every test has a single expected outcome. New payloads land as new hardcoded cases (with the originating issue/PR cited in the test name), not as random generators. This keeps the suite reproducible and Sentinel-reviewable.

## When to Run Each Test Type

| Test Type | Command | When to Run | CI? |
|-----------|---------|-------------|-----|
| Unit | `pnpm test:unit` | Every PR, every local change | ✅ Every PR + push to `main` |
| E2E | `pnpm test:e2e` | Every PR, every local change | ✅ Every PR + push to `main` |
| Security | `pnpm test:security` | Every PR, every local change | ✅ Every PR + push to `main` |
| Integration | `pnpm test:integration` | Manual, before major releases | ❌ Requires real Copilot SDK |
| Smoke | Manual checklist (`docs/SMOKE-TEST.md`) | Manual, final pre-release gate | ❌ Requires real Copilot engine + TTY |
| All automated | `pnpm test` | Full local validation | ✅ (unit + e2e + security + integration-skip) |

**Integration tests** require a real Copilot SDK session. Set `COUNCIL_INTEGRATION=1` to opt in:
```bash
COUNCIL_INTEGRATION=1 pnpm test:integration
```

**Smoke tests** are the final gate before cutting a release. They exercise the full system end-to-end with a live LLM and interactive TTY. See `docs/SMOKE-TEST.md` for the checklist.

## CI Integration

- CI runs automatically on every PR targeting `main` and on every push to `main` (`.github/workflows/ci.yml`)
- Pipeline: typecheck → lint → unit tests → e2e tests → security tests
- All steps must pass before Sentinel review begins
- Flaky tests must be fixed immediately, not skipped
- Integration tests are manual-only (not in CI — they cost real tokens)
