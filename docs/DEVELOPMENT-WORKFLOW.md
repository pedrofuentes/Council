# Development Workflow

> Extended workflow context for AI agents. Referenced from AGENTS.md.
> **The MUST rules (TDD, branching, worktrees, incremental development, Sentinel) are enforced in AGENTS.md.**
> This document covers the detailed HOW.

---

## Git Worktrees for Isolation

Every increment MUST use a git worktree for isolation:

```bash
# Fetch latest main, create worktree with new branch
git fetch origin main
git worktree add .worktrees/feature-name -b feature/feature-name main

# Change into the worktree
cd .worktrees/feature-name

# Install dependencies inside the new worktree (worktrees do not share node_modules)
pnpm install --frozen-lockfile

# List active worktrees
git worktree list

# Remove a worktree when done (after merge — cd back to main worktree first)
cd S:\Pedro\Projects\Council
git worktree remove .worktrees/feature-name
git branch -D feature/feature-name
```

### Why Worktrees Are Required
- Prevents interference between parallel work
- Each agent/increment has a clean working directory
- No risk of uncommitted changes from one task affecting another
- Easy cleanup after merge

## Branching Details

### Branch Lifecycle
1. Fetch latest: `git fetch origin main`
2. Create worktree + branch from `main`: `git worktree add .worktrees/name -b feature/name main && cd .worktrees/name`
3. Install dependencies in the new worktree: `pnpm install --frozen-lockfile`
4. TDD: write failing tests, implement, refactor
5. Commit following the format in AGENTS.md
6. Push branch: `git push -u origin feature/name`
7. Open PR: `gh pr create` or via GitHub UI
8. Invoke Sentinel for review
9. Address any Sentinel feedback, re-submit
10. On Sentinel approval, merge to `main`
11. Cleanup: `cd S:\Pedro\Projects\Council && git worktree remove .worktrees/name && git branch -D feature/name`

### Branch Naming Convention
| Prefix | Use For |
|--------|---------|
| `feature/` | New features |
| `fix/` | Bug fixes |
| `refactor/` | Code refactoring |
| `docs/` | Documentation changes |
| `test/` | Test additions or fixes |
| `chore/` | Build, CI, dependency updates |

## Pull Request Process

### Before Opening a PR
1. All tests pass in the worktree
2. Linting passes
3. Commit messages follow the format
4. PR represents a single logical unit

### PR Title Format
`type(scope): Short description`

### Sentinel Review
→ See [`docs/SENTINEL.md`](./SENTINEL.md) for the full process and invocation methods.

### After Merge
```bash
cd S:\Pedro\Projects\Council
git worktree remove .worktrees/feature-name
git branch -D feature/name
git pull origin main
```
- Start next increment from the plan
- If other worktrees are in progress, rebase them: `cd .worktrees/other && git fetch origin main && git rebase origin/main`

## Continuous Integration

### Platform Smoke Tests
- **Workflow**: [`.github/workflows/platform-smoke.yml`](../.github/workflows/platform-smoke.yml)
- **Purpose**: Catches OS-specific regressions (build/typecheck breakage, TTY-detection differences, shell quirks) that a single-OS unit test run wouldn't surface, by exercising the built CLI binary end-to-end on every supported platform.
- **Triggers**: `pull_request` targeting `main`, `push` to `main`, and manual `workflow_dispatch`.
- **Scope**: A `fail-fast: false` matrix across `ubuntu-latest`, `macos-latest`, and `windows-latest` — one OS failing does not cancel the others. Each OS job:
  1. Installs dependencies (`pnpm install --frozen-lockfile`) and builds the CLI (`pnpm --filter @council-ai/cli build`)
  2. Typechecks (`pnpm --filter @council-ai/cli typecheck`)
  3. Runs CLI smoke checks: `--version`, `--help`, and `templates` (offline)
  4. Runs TUI-fallback smoke checks: confirms bare `council`, `--help`, `--no-tui`, and `doctor --help` all fall back to the classic CLI (rather than launching the Ink TUI) when run non-interactively, since CI runners are non-TTY
- **Pass/fail interpretation**: A failing OS job means the CLI failed to build/typecheck or one of the smoke assertions didn't match on that platform — treat it as a real, platform-specific regression and a required merge blocker, not a flaky/advisory check.

## Sub-Agent Delegation

### When to Delegate
- Complex research that requires deep analysis
- Documentation generation
- Test data creation or fixture generation
- Performance profiling and optimization analysis
- Security vulnerability assessment

### How to Delegate
- Provide the sub-agent with full context (requirements, constraints, relevant code)
- Each sub-agent works in its own context
- Integrate sub-agent output back into the main work
- All sub-agent output must follow AGENTS.md rules

## Environment Setup

### Prerequisites
- Node.js 24+
- pnpm (`npm install -g pnpm`)
- GitHub Copilot CLI (`npm install -g @github/copilot`)
- GitHub Copilot subscription (Individual, Business, or Enterprise)
- Copilot authenticated (`gh auth login`; verify with `gh auth status`)

### Initial Setup
```bash
git clone <repo-url> && cd council
pnpm install
pnpm build
pnpm test
```

### IDE Recommendations
- VS Code with ESLint + Prettier extensions
- TypeScript strict mode enabled
- Terminal: Windows Terminal or similar (Ink requires TTY support)
