# Contributing to Council

Thanks for your interest in contributing to **Council** (`@council-ai/cli`)!

> [`AGENTS.md`](./AGENTS.md) is the **authoritative** source for the development
> workflow, quality gates, and all process rules. This document is a summary —
> if anything here conflicts with `AGENTS.md`, `AGENTS.md` wins.
>
> **Maintainers:** For launch operations, see [`docs/LAUNCH-RUNBOOK.md`](./docs/LAUNCH-RUNBOOK.md).

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

## Ways to Contribute

Council welcomes contributions at different levels of rigor depending on what
you're contributing:

### 🎯 Panel Recipes, Documentation, and Examples (lighter process)

These contributions help the community without requiring the full code workflow:

- **Panel YAML recipes** — share expert panel configurations for specific domains
  (e.g., a code-review panel, security-analysis panel, or creative-writing
  panel). Self-check with `council panel lint <your-panel.yaml>` before
  submitting. Submit via PR to a future panel gallery or link in GitHub Issues.
- **Documentation fixes** — typos, clarifications, improved examples, or new
  guides. Edit the relevant `.md` file and open a PR.
- **Example transcripts** — real-world Council session examples demonstrating
  interesting use cases or workflows. Share as GitHub Issues or discussions.

**Process**: Open a PR with your changes. Prettier must pass
(`npx prettier --check <file>`), but you don't need TDD commit choreography or
the full pre-push verification. A maintainer will review and merge. Look for
`good-first-issue` labels on GitHub Issues to get started.

### 💻 Code Contributions (full TDD + Sentinel workflow)

Code changes to the CLI, engine, or core libraries follow a rigorous,
mechanically-enforced process described below and in
[`AGENTS.md`](./AGENTS.md). This ensures quality and consistency for the
codebase.

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

### 4. Code review — Sentinel as review of record

All merges to `main` require two gates:

1. **Branch protection** — the `Typecheck, Lint & Test` CI check must pass, and
   an approving review must be recorded on the pull request.

2. **Sentinel review (mandatory quality gate)** — every change — including
   one-line fixes, documentation, and configuration — must receive an **APPROVED**
   or **CONDITIONAL** verdict from Sentinel before it is merged. Sentinel is an
   independent, non-author, read-only automated reviewer that verifies TDD
   compliance, runs the full test suite, and performs multi-dimension
   security/quality analysis. Its verdict is persisted to the PR as the
   authoritative review record. No code merges without a passing Sentinel verdict.
   You do not review your own code.

Sentinel is the project's **code review of record**. See
[`docs/SENTINEL.md`](./docs/SENTINEL.md) for the full specification.

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
