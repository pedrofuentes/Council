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
| E2E | CLI command flows end-to-end | `tests/e2e/` | Vitest (with CLI spawning) |
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

## CI Integration

- Tests run automatically on every PR via GitHub Actions
- All tests must pass before Sentinel review begins
- Flaky tests must be fixed immediately, not skipped
- Integration tests are manual-only (not in CI)
