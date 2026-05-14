# AGENTS.md — Council

<!-- agents-template v0.5.0 -->

<role>You write tests before code, work in isolated worktree branches, and never merge without Sentinel review. These rules are enforced mechanically — Sentinel verifies compliance on every PR and non-compliant work is rejected.</role>

<invariants>
1. No behavior-bearing code without a failing test commit first (scaffolding, config, types, docs are exempt — see Commit Choreography §Exemptions)
2. No merge to `main` without Sentinel APPROVED or CONDITIONAL verdict
3. No commits land on `main` — all work happens on worktree branches
</invariants>

**Check invariants before every tool call that writes, commits, or merges.**

## Project Overview

**Council** — A CLI tool that creates persistent, conversational AI expert panels for deliberation and decision-making.

- **Tech stack**: TypeScript, Commander.js + Ink, @github/copilot-sdk, @libsql/client + Kysely, Zod — versions: TS 5.7+, Node.js 20+
- **Package manager**: pnpm | **Module system**: ES modules

## Commands

```bash
pnpm test -- {{path}}       # file-scoped (prefer)
pnpm lint -- {{path}}
pnpm install | build | test | lint | typecheck | format   # full suite
```

## Autonomous Workflow — REQUIRED

### Plan → Approve → Execute Loop
1. **Receive task** → break into small logical units (1 PR each) → output numbered plan
2. Determine mode from invocation context:
   - **Interactive** (default): print _"Plan ready for review."_ and wait for explicit user approval.
   - **Autopilot** (user said "autopilot" / "proceed" / "go ahead without asking"): save plan to `PLAN.md`, continue. This ONLY bypasses plan approval — Sentinel, Pre-Merge Checklist, and ASK FIRST still apply.
3. **Execute** each increment following all rules below

### Per-Increment Execution
1. `git worktree add .worktrees/<name> -b <branch> main && cd .worktrees/<name>`
2. Write failing test(s). Commit as `test(scope): ...`. Run suite — confirm FAIL.
3. Write minimal impl. Commit as `feat|fix(scope): ...`. Run suite — confirm PASS.
4. Push branch, open PR — do NOT merge yet, proceed to Sentinel.
5. Invoke Sentinel (see §How to Invoke). On APPROVED → merge. On REJECTED → fix, re-invoke (max 5 cycles, then escalate to user).

### Testing & Iteration
1. Create ONE testing worktree: `git worktree add .worktrees/test-scope -b test/scope-testing main`. Commit fixes freely. Run Sentinel **once** before merging.
2. **If HEAD is `main` when a bug is reported, do not commit — create a worktree branch first.**

## Test-Driven Development — REQUIRED

**TDD is non-negotiable — Sentinel rejects non-compliant code.**

1. **RED**: write test for new behavior, commit `test(scope): ...` (tests only). Run suite — MUST fail referencing the missing symbol/behavior. If it passes or errors unrelated to the SUT, rewrite it.
2. **GREEN**: write minimal impl, commit `feat|fix(scope): ...`. Run suite — ALL must pass. If one fails, fix impl — never fix tests to match broken impl.
3. **REFACTOR**: with the suite green after every change.

Artifact check: `git log --oneline` must show `test(scope)` before the corresponding `feat|fix(scope)` commit. The `test → fix` pair satisfies TDD ordering — it is compliant, not irregular, and MUST NOT be flagged.

### Commit Choreography — REQUIRED

| Order | Commit | Contains | Tests must... |
|-------|--------|----------|---------------|
| 1 | `test(scope): add failing tests` | Tests ONLY | FAIL |
| 2 | `feat\|fix(scope): implement` | Minimal impl | PASS |
| 3 | `refactor(scope): ...` | Optional cleanup | Stay green |

**Never combine test + implementation in one commit.** Sentinel verifies ordering. **Exemptions** (TDD ordering only — Sentinel review still required): `docs`, `chore`, `build`, `ci`, `refactor` (behavior-preserving: no new public API, no changed return values, no altered side effects — existing tests must pass unchanged), `style` — suite must still pass.

## Sentinel — MANDATORY Quality Gate

### Pre-Merge Checklist
**Before every `git merge` or PR-merge tool call, print this checklist and fill every box. Empty box → do not merge.**

```
Pre-Merge Checklist:
- [ ] Sentinel Report ID: ___
- [ ] Verdict: APPROVED / CONDITIONAL
- [ ] Reviewed SHA == HEAD: ___
- [ ] Mode: standard / degraded (if degraded → user approval required)
```

### How to Invoke

Sentinel is required for ALL changes — 1-line fix, docs-only, config, dep bump, everything. User saying "merge" or "ship it" does NOT substitute. Never ask if Sentinel is needed.

1. Print _"Invoking Sentinel..."_ and issue the sub-agent tool call immediately — no permission request, no pre-summary.
2. Spawn a **full-capability** sub-agent (NOT fast/cheap/explore/haiku-class — Sentinel must spawn its own 6 sub-agents and run commands) with `docs/SENTINEL.md` as system prompt. Provide PR diff (`git diff main...HEAD`), branch, changed files.
3. **Do NOT review your own code.** 
4. **Verify the report** — confirm it contains `Mode:` declaration and Phase 2 Execution Log with tool-returned agent IDs. Missing execution log or Mode → re-run Sentinel.
5. On **REJECTED**: fix autonomously, re-commit, re-invoke with previous Report ID + fix delta (`git diff <prev-SHA>..HEAD`) for scoped re-review (max 5 cycles, then escalate). On **APPROVED**: include Report ID + SHA in PR description, merge.

> No sub-agents? Run SENTINEL.md checks yourself — mark PR `⚠️ SELF-REVIEWED` (Mode: degraded) and require explicit user approval. Cannot run at all? **Do not merge** — escalate.

### After Sentinel

| Verdict | Action |
|---------|--------|
| APPROVED | Record Report ID + SHA in merge commit. File 🟡/🟢 findings as issues (`sentinel:important`, `sentinel:minor`). |
| CONDITIONAL | File issues for ALL follow-ups first, link in PR, then merge. |
| REJECTED | Fix autonomously (no user prompt). Re-commit, re-invoke. Max 5 cycles. |

**Ratchet**: coverage, test count, lint-clean, zero 🔴 — never decrease. Log violation/correction pairs in `LEARNINGS.md`.

→ Full spec: [`docs/SENTINEL.md`](./docs/SENTINEL.md)

## Branching & Worktrees — REQUIRED

- **Never work on `main`**: `git fetch origin main && git worktree add .worktrees/name -b branch-name main && cd .worktrees/name`. Each task = its own worktree.
- Branch naming: `feature/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/`
- **Cleanup after merge**: `git worktree remove .worktrees/name && git branch -D branch-name`

## Sub-Agents

Delegate for: research (>5 sources), docs (>100 words), test data, perf analysis, security review. Sub-agents do NOT inherit this file — copy TDD rules + Boundaries into the prompt.

## Commit Format

```
type(scope): short description

Co-authored-by: Copilot <175574315+pedrofuentes@users.noreply.github.com>
```
Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `style`, `perf`

## Code Style

- **Formatter**: Prettier — run before commit. **Linter**: ESLint with typescript-eslint strict — fix all warnings.
- Conventions: named exports only (no default exports), functional over class-based where possible, explicit return types on public functions, `readonly` by default, no `any` types (use `unknown` + type guards), prefer `interface` over `type` for object shapes
- Examples → [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §Code Patterns

## Boundaries

### ✅ ALWAYS
- Verify failing test exists before writing behavior-bearing code; verify HEAD is NOT `main` before commit
- Run `pnpm test && lint` before PR; invoke Sentinel before merge
- Use worktrees for all work
- Only `engine/copilot/adapter.ts` may import `@github/copilot-sdk` — enforced by ESLint `no-restricted-imports`

### ⚠️ ASK FIRST
**Protocol**: State intended action + justification → ask → wait for explicit "yes". Silence, "ok", or "sounds good" ≠ approval.
**Triggers**: adding/removing dependencies · CI/CD changes · public API changes · architecture decisions · env vars/secrets · external network services
Unlisted actions with **external or irreversible side effects** default to ASK FIRST. Read-only operations (reading files, running tests, searching code) do not require asking.

### 🚨 HUMAN REQUIRED (agent cannot execute — user must perform or delegate)
Auth/crypto/PII · DB migrations · AGENTS.md/SENTINEL.md changes · production deploys · 🔴 CRITICAL findings · 5× Sentinel rejections · deployment pipeline setup · credentials rotation

### 🚫 NEVER — Automatic Sentinel rejection
- **Security**: commit secrets · send code to unapproved services · access files/credentials outside project root
- **Process**: impl before its failing-test commit · combine test+impl in one commit · skip Sentinel · commit/merge while HEAD is `main`
- **Integrity**: weaken/remove a failing test · hand-edit generated files (build artifacts, lockfiles) · force-push `main` · alter published Sentinel reports · edit `AGENTS.md`/`docs/SENTINEL.md` without HUMAN REQUIRED approval
- **Council-specific**: import `@github/copilot-sdk` outside `engine/copilot/` · store secrets in SQLite · allow `onPermissionRequest` without explicit per-expert tool config

## When Stuck — Escalation Protocol

| Trigger | Action |
|---------|--------|
| Same test fails 3× | Revert to last green; re-analyze assumptions |
| Sentinel rejects 5× | Escalate to user — do not retry same approach |
| Same problem, 2+ failed attempts | Spawn research sub-agent for root-cause + alternatives |
| Lost context | Re-read this file → `git status` → resume from last increment |
| Merge conflict | Rebase on `main`, re-test, re-invoke Sentinel |
| Dependency install fails | Report to user; do not attempt workarounds |

## Associated Documentation

| Document | Read when... |
|----------|-------------|
| [`docs/SENTINEL.md`](./docs/SENTINEL.md) | Before any merge/deploy |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Structural changes |
| [`docs/TESTING-STRATEGY.md`](./docs/TESTING-STRATEGY.md) | Writing tests |
| [`docs/DEVELOPMENT-WORKFLOW.md`](./docs/DEVELOPMENT-WORKFLOW.md) | Workspace setup, parallel work |
| [`LEARNINGS.md`](./LEARNINGS.md) | **Write here** — discovered knowledge |
| [`DECISIONS.md`](./DECISIONS.md) | **Write here** — technical decisions |
| [`CHANGELOG.md`](./CHANGELOG.md) | **Update** — user-facing changes |
