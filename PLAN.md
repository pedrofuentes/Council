# Plan — fix debate.ts regressions (#208 #206 #184)

Single PR, file: `packages/cli/src/core/debate.ts` (+ `core/types.ts` for the new event).

1. **#208** — `HumanInputProvider.getInput()` is awaited without try/catch; a throw
   propagates unguarded. Wrap in try/catch → emit structured `error` + `cost.update`,
   return null (parity with AI turn failure).
2. **#206** — human `result.content` taken verbatim; blank/whitespace persisted. Trim,
   treat empty as cancelled (error + cost.update, no turn.end), persist trimmed content.
3. **#184** — failed-attempt deltas already forwarded before retry. Add `turn.discard`
   event; emit before `turn.retry` so consumers drop accumulated partial content.

TDD: `test(debate)` (RED) → `fix(debate)` (GREEN). Then pnpm test + lint, push, PR. STOP.
