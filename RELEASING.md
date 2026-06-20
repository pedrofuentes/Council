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
3. **Merging the release PR** triggers `.github/workflows/release-please.yml`, which
   creates the git tag and a **GitHub Release** and, in the same run, starts the
   **`publish` job** (gated on `releases_created == true`).
4. The `publish` job **pauses for approval** (environment `npm-publish`, required
   reviewer). A maintainer approves in the Actions UI, then it publishes
   `@council-ai/cli` to npm via **OIDC Trusted Publishing** with **provenance**.
   - No long-lived npm tokens are stored or used in steady state.

**Manual / fallback publish**: `gh workflow run release-please.yml --ref main`
re-runs the workflow and publishes if a release is pending. Emergency fallback:
`cd packages/cli && npm publish --access public` (no provenance).

## One-time bootstrap (first publish)

A Trusted Publisher cannot be configured on npm until the package exists, so the
**first** publish is manual:

1. A human org member runs, from the built `cli` package:
   ```bash
   npm publish --access public --no-provenance
   ```
   to publish `@council-ai/cli@0.1.0`.
   - `--no-provenance` is required: `packages/cli/package.json` sets `publishConfig.provenance: true`, which npm inherits and then fails outside GitHub Actions CI (no OIDC). CI continues to publish with provenance; the manual bootstrap cannot.
   - This bootstrap `0.1.0` is published **without provenance**.
2. On npmjs.com, configure the **Trusted Publisher** for `@council-ai/cli`,
   pointing at repo `pedrofuentes/Council`, workflow `.github/workflows/release-please.yml`, and environment `npm-publish`.
3. From then on, every CI-published version carries **provenance** (the first
   CI-published version is the first to include it).

## Rollback

- npm does **not** allow true unpublish after 72 hours.
- To pull back a bad release: run `npm deprecate` on the affected version and
  ship a **patch release** with the fix.

## Namespace note

- The `councilai` npm org is **reserved-only** (anti-typosquat). Nothing is
  published under it; all releases ship as `@council-ai/cli`.

## Human bootstrap checklist (first release)

> The maintainer performs these steps once. The agent does not publish or handle credentials.

**Prerequisites**
- [ ] You are a member of the `council-ai` npm org with publish rights, and npm 2FA is enabled.
- [ ] The `councilai` npm org/name is reserved (publish nothing there — anti-typosquat only).
- [ ] Recommended before the first CI publish: resolve issue #1194 (pin the `npm` version in `release-please.yml`). The publish job in `release-please.yml` runs `npm install -g npm@11.5.0` before publishing.

**Bootstrap publish (one-time, manual — no provenance on `0.1.0`)**
1. On a clean checkout of `main`: `pnpm install --frozen-lockfile`.
2. Build the package: `pnpm --filter @council-ai/cli build`.
3. Validate packaging: `pnpm --filter @council-ai/cli publint` and `pnpm --filter @council-ai/cli attw` (both must pass). _(attw runs here and in CI rather than in the publish hook.)_
4. Optional dry run: `cd packages/cli && npm publish --dry-run --access public --no-provenance`.
5. Publish: `cd packages/cli && npm publish --access public --no-provenance`, entering your npm 2FA OTP. This ships `@council-ai/cli@0.1.0` **without** provenance.

**Configure Trusted Publishing (one-time, after the package exists)**
6. On npmjs.com → `@council-ai/cli` → Settings → **Trusted Publishers** → add a GitHub Actions publisher pointing at repo `pedrofuentes/Council`, workflow `.github/workflows/release-please.yml`, and environment `npm-publish`.

**Steady state (provenance, no tokens)**
7. Merge Conventional-Commit PRs to `main`; release-please maintains a release PR.
8. Merge the release PR → `.github/workflows/release-please.yml` creates the tag + GitHub Release and, in the same run, starts the `publish` job (gated on `releases_created == true`). The job waits for `npm-publish` environment approval, then publishes via OIDC Trusted Publishing **with provenance** (the first CI-published version is the first to carry provenance).
