# Releasing

How `@council-ai/cli` is versioned and published.

## Versioning

- Releases follow **semver**, driven by **Conventional Commits**.
- Versioning and changelog generation are automated by **release-please** in
  **manifest mode**, component `cli`.
- Release tags use the form `cli-v0.1.1`.
- release-please opens and maintains a "release PR" that bumps the version and
  updates `CHANGELOG.md` based on the merged commits.

## Stability & Versioning Policy

### Pre-1.0 (0.x) Semantics

Council is currently **pre-1.0 software** (`0.x` versions). Per [Semantic
Versioning](https://semver.org/#spec-item-4):

- **Minor versions (0.x.0) MAY include breaking changes** — the public API is
  not yet stable.
- **Patch versions (0.x.y) contain backward-compatible bug fixes and small
  enhancements**.
- Breaking changes are **clearly documented** in `CHANGELOG.md` with a
  `BREAKING CHANGE:` footer in the commit message. release-please surfaces
  these prominently in release notes.

### Deprecation Policy

When feasible, features scheduled for removal are **deprecated with at least
one minor release's notice**:

1. The deprecation is **announced in `CHANGELOG.md`** with guidance on the
   replacement API or migration path.
2. The deprecated feature continues to function with a runtime warning (where
   applicable) for at least one minor release.
3. The feature is **removed in a subsequent minor release** (pre-1.0) or major
   release (post-1.0).

Due to the pre-1.0 status, some breaking changes may be necessary without a
full deprecation cycle if they address critical design issues.

### Reaching 1.0

Version `1.0.0` will signify:

- The **public API is stable** — breaking changes will increment the major
  version per strict semver.
- Core functionality is **production-ready** with comprehensive test coverage
  and real-world validation.
- **Deprecation guarantees** — deprecated features will remain supported for at
  least one major version after deprecation.

Until 1.0, treat Council as actively evolving software where the API may shift
to accommodate learnings from real-world use.

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

**Manual / fallback publish**: `gh workflow run release-please.yml --ref main` re-runs
release-please, but it publishes **only if that run creates a new release** (i.e. a pending
release PR is processed into a release in the same run). It will **not** re-publish a version
that was already released (`releases_created` is `false`, so the gated `publish` job is skipped).
To re-publish or ship a version outside this flow, use the emergency fallback:
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

**Configure Trusted Publishing (one-time, after the package exists)** 6. On npmjs.com → `@council-ai/cli` → Settings → **Trusted Publishers** → add a GitHub Actions publisher pointing at repo `pedrofuentes/Council`, workflow `.github/workflows/release-please.yml`, and environment `npm-publish`.

**Steady state (provenance, no tokens)** 7. Merge Conventional-Commit PRs to `main`; release-please maintains a release PR. 8. Merge the release PR → `.github/workflows/release-please.yml` creates the tag + GitHub Release and, in the same run, starts the `publish` job (gated on `releases_created == true`). The job waits for `npm-publish` environment approval, then publishes via OIDC Trusted Publishing **with provenance** (the first CI-published version is the first to carry provenance).
