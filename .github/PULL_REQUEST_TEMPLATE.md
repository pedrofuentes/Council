<!--
Thanks for contributing to Council! Please complete the checklist below.
See AGENTS.md and CONTRIBUTING.md for the authoritative workflow.
-->

## Summary

Describe what this PR changes and why.

## Related Issues

Closes #

## Checklist

- [ ] A **failing test was committed before the implementation** (TDD ordering:
      `test(scope): ...` precedes `feat|fix(scope): ...`), or this change is
      TDD-exempt (`docs`, `chore`, `build`, `ci`, `refactor`, `style`).
- [ ] Commits follow **Conventional Commits** (`type(scope): description`).
- [ ] `pnpm test` passes (full suite green).
- [ ] `pnpm lint` passes (zero warnings).
- [ ] `pnpm typecheck` passes.
- [ ] **Sentinel review** is required and must be APPROVED/CONDITIONAL before
      this PR is merged to `main`.

## Notes for Reviewers

Anything reviewers should pay particular attention to.
