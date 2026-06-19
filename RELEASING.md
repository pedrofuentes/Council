# Releasing

How `@council-ai/cli` is versioned and published.

## Versioning

- Releases follow **semver**, driven by **Conventional Commits**.
- Versioning and changelog generation are automated by **release-please** in
  **manifest mode**, component `cli`.
- Release tags use the form `cli-v0.1.1`.
- release-please opens and maintains a "release PR" that bumps the version and
  updates `CHANGELOG.md` based on the merged commits.

## Steady-state release flow

1. Merge feature/fix PRs to `main` using Conventional Commit messages.
2. release-please keeps an open release PR with the next version + changelog.
3. **Merging the release PR** creates the git tag and a **GitHub Release**.
4. The GitHub Release triggers `.github/workflows/release.yml`, which publishes
   `@council-ai/cli` to npm via **OIDC Trusted Publishing** with **provenance**.
   - No long-lived npm tokens are stored or used in steady state.

## One-time bootstrap (first publish)

A Trusted Publisher cannot be configured on npm until the package exists, so the
**first** publish is manual:

1. A human org member runs, from the built `cli` package:
   ```bash
   npm publish --access public
   ```
   to publish `@council-ai/cli@0.1.0`.
   - This bootstrap `0.1.0` is published **without provenance**.
2. On npmjs.com, configure the **Trusted Publisher** for `@council-ai/cli`,
   pointing at this repository and the `release.yml` workflow.
3. From then on, every CI-published version carries **provenance** (the first
   CI-published version is the first to include it).

## Rollback

- npm does **not** allow true unpublish after 72 hours.
- To pull back a bad release: run `npm deprecate` on the affected version and
  ship a **patch release** with the fix.

## Namespace note

- The `councilai` npm org is **reserved-only** (anti-typosquat). Nothing is
  published under it; all releases ship as `@council-ai/cli`.

## Human bootstrap checklist (finalized in P10)

_Placeholder — the detailed, finalized bootstrap checklist will be completed in
P10._
