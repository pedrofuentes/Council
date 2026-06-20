# Contributing to Council

Thanks for your interest in contributing to **Council** (`@council-ai/cli`)!

> [`AGENTS.md`](./AGENTS.md) is the **authoritative** source for the development
> workflow, quality gates, and all process rules. This document is a summary —
> if anything here conflicts with `AGENTS.md`, `AGENTS.md` wins.

## Prerequisites

- **Node.js 24+**
- **pnpm** (the project's package manager)
- A POSIX-compatible shell or Windows PowerShell

## Getting Started

```bash
pnpm install      # install dependencies
pnpm build        # build all packages
pnpm test         # run the test suite
pnpm lint         # run ESLint (typescript-eslint strict)
pnpm typecheck    # run the TypeScript type checker
pnpm format       # run Prettier
```

Prefer file-scoped runs while iterating:

```bash
pnpm test -- path/to/file.test.ts
pnpm lint -- path/to/file.ts
```

## Development Workflow

Council follows a strict, mechanically-enforced workflow. The essentials:

### 1. Work in an isolated worktree

Never commit on `main`. Each task gets its own worktree and branch off the
latest `main`:

```bash
git fetch origin main
git worktree add .worktrees/<name> -b <type>/<branch-name> origin/main
cd .worktrees/<name>
```

Branch prefixes: `feature/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/`.

### 2. Test-Driven Development (TDD) — required

1. **RED** — write a failing test for the new behavior. Commit as
   `test(scope): ...` (tests only). Run the suite and confirm it fails.
2. **GREEN** — write the minimal implementation. Commit as
   `feat|fix(scope): ...`. Run the suite and confirm it passes.
3. **REFACTOR** — clean up while keeping the suite green.

Never combine a test and its implementation in a single commit. Documentation,
chore, build, ci, refactor, and style changes are exempt from the test-first
rule, but the suite must stay green.

### 3. Verify before pushing

Run `pnpm test`, `pnpm lint`, and `pnpm typecheck` and ensure they are green
with zero warnings before opening a pull request.

### 4. Mandatory Sentinel review

Every change — including one-line fixes and docs-only changes — must pass a
**Sentinel** review before it is merged to `main`. See
[`docs/SENTINEL.md`](./docs/SENTINEL.md) for the full specification. You do not
review your own code.

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `style`,
`perf`.

## Code Style

- **Named exports only** — no default exports.
- **typescript-eslint strict** — fix all warnings; no `any` (use `unknown` +
  type guards).
- Run **Prettier** before committing.
- Prefer functional over class-based code, explicit return types on public
  functions, `readonly` by default, and `interface` over `type` for object
  shapes.

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for code patterns and
[`docs/TESTING-STRATEGY.md`](./docs/TESTING-STRATEGY.md) for testing guidance.

## Code of Conduct

This project is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md). By
participating, you are expected to uphold it.

## Security

Please report vulnerabilities privately — see [`SECURITY.md`](./SECURITY.md).
