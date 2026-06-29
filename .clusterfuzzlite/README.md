# ClusterFuzzLite fuzzing for `@council-ai/cli`

This directory wires [ClusterFuzzLite](https://google.github.io/clusterfuzzlite/)
into the repo so OpenSSF Scorecard's **Fuzzing** check passes and — more
importantly — so the CLI's highest-risk untrusted-input function is continuously
fuzzed. Scorecard detects fuzzing by the presence of
[`Dockerfile`](./Dockerfile) here.

## What gets fuzzed

| Target                     | Function (module)                                                                           | Invariant checked                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fuzz_strip_control_chars` | `stripControlChars` / `toSingleLineDisplay` (`packages/cli/src/cli/strip-control-chars.ts`) | never throws; `stripControlChars` is idempotent (no control sequence survives one pass); `toSingleLineDisplay` never leaves a CR/LF/TAB or U+2028/U+2029 in its output |

`stripControlChars` / `toSingleLineDisplay` are the last line of defence before
LLM-authored text (panel names, expert display names, roles, topics) reaches the
user's terminal. A miss lets an attacker smuggle ANSI/OSC escapes, C1 controls,
bidi-override characters (Trojan Source, CVE-2021-42574), or zero-width
characters onto the TTY — spoofing prompts, exfiltrating via OSC 8 hyperlinks, or
visually reordering text. Both functions are pure and documented to never throw,
which makes them an ideal fuzz surface.

Each `fuzz_*.js` target drives one such function and asserts its documented
contract; any throw — or a surviving control sequence / line break — is a real
finding.

## How it fits together

- [`fuzz_strip_control_chars.js`](./fuzz_strip_control_chars.js) — the Jazzer.js
  target. CommonJS (see [`package.json`](./package.json)) so it can
  `require("@jazzer.js/core")` under the OSS-Fuzz launcher.
- [`tsconfig.fuzz.json`](./tsconfig.fuzz.json) — a standalone, minimal tsconfig
  that transpiles the sanitizer (and its only local import) to ESM JavaScript in
  `packages/cli/dist-fuzz/`. The CommonJS target loads it via a cached dynamic
  `import()`.
- [`Dockerfile`](./Dockerfile) + [`build.sh`](./build.sh) — the ClusterFuzzLite
  build: transpile the sanitizer, make Jazzer.js resolvable, then
  `compile_javascript_fuzzer` each target into a libFuzzer binary.
- [`../.github/workflows/cflite_pr.yml`](../.github/workflows/cflite_pr.yml) —
  fuzzes the code change on every PR that touches the sanitizer or this config.
- [`../.github/workflows/cflite_batch.yml`](../.github/workflows/cflite_batch.yml)
  — a scheduled batch run that grows the corpus in the Actions cache.

## Why CommonJS targets for an ESM package

`@council-ai/cli` is pure ESM (`"type": "module"`), but the OSS-Fuzz JavaScript
toolchain and `@jazzer.js/core` are consumed via `require()`. The local
[`package.json`](./package.json) sets `"type": "commonjs"` so the `fuzz_*.js`
files here are CommonJS; they load the compiled ESM sanitizer from
`../packages/cli/dist-fuzz/*.js` via a cached dynamic `import()`.

## Run it locally

Jazzer.js runs natively on macOS/modern Linux, so the harness can be exercised
without Docker:

```sh
# from the repo root — transpile the sanitizer, then fuzz for 60s
pnpm fuzz

# or run a target directly with custom libFuzzer flags
pnpm fuzz:build
pnpm exec jazzer .clusterfuzzlite/fuzz_strip_control_chars -- -max_total_time=30
```

A clean exit with no `crash-*` file written is the expected pass.

The full Docker build (`compile_javascript_fuzzer` wrapping the targets) only
runs in CI / OSS-Fuzz infrastructure; the base image is amd64-only. To reproduce
it locally on an amd64 host:

```sh
docker build --platform linux/amd64 -t council-cflite -f .clusterfuzzlite/Dockerfile .
mkdir -p build-out
docker run --rm --platform linux/amd64 \
  -e SANITIZER=none -e FUZZING_ENGINE=libfuzzer -e FUZZING_LANGUAGE=javascript \
  -v "$(pwd)/build-out:/out" council-cflite compile
```

## JavaScript fuzzers use no sanitizer

`sanitizer: none` in the workflows (and `SANITIZER=none` for `compile`) is
required: passing `address` errors with "JavaScript projects cannot be fuzzed
with sanitizers."

## Jazzer.js version is coupled to the base image's glibc

[`build.sh`](./build.sh) installs `@jazzer.js/core@2.1.0` for the Docker build.
Its prebuilt native addon links against glibc 2.31 (the OSS-Fuzz base image's
floor), so it loads there and on any newer glibc. Jazzer.js 4.x ships a prebuilt
that requires `GLIBC_2.32` and fails to `dlopen` on the 2.31 base. The repo's
`@jazzer.js/core` devDependency tracks 4.x for local runs; the
`FuzzedDataProvider` API the targets use is identical across both. Bump the
`build.sh` pin once the OSS-Fuzz base moves to a newer glibc.

## Maintaining the base-image pin

[`Dockerfile`](./Dockerfile) pins `gcr.io/oss-fuzz-base/base-builder-javascript`
by digest so Scorecard's Pinned-Dependencies check stays satisfied. Refresh it
periodically (the OSS-Fuzz base images update often):

```sh
TOKEN="$(curl -fsSL 'https://gcr.io/v2/token?scope=repository:oss-fuzz-base/base-builder-javascript:pull&service=gcr.io' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')"
curl -fsSI -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
  "https://gcr.io/v2/oss-fuzz-base/base-builder-javascript/manifests/v1" \
  | grep -i docker-content-digest
```

Then update the `@sha256:...` in [`Dockerfile`](./Dockerfile).

## npm install pinning is best-effort

Scorecard's Pinned-Dependencies check also flags the two `npm install` lines in
[`build.sh`](./build.sh) as "not pinned by hash" (the TypeScript compiler and
`@jazzer.js/core@2.1.0`). Both are hardened as far as practical:

- **Repo-pinned versions** — TypeScript installs the repo's pinned devDependency
  (`require('./package.json').devDependencies.typescript`) and Jazzer.js is fixed
  at exactly `2.1.0`. Neither floats to `latest`.
- **`--ignore-scripts`** on both, so no untrusted install-time scripts run during
  the OSS-Fuzz build. Jazzer.js ships a prebuilt native addon, so it still loads.

True hash pinning (`npm ci` against a committed `package-lock.json`) is not
viable here: each tool installs into a throwaway `mktemp -d` with no
package.json/lockfile, the TypeScript version is resolved from the workspace
manifest at build time, and committing per-tool lockfiles in this directory would
duplicate and drift against the real manifests. These two alerts are an accepted,
documented best-effort residual; the OSS-Fuzz base image itself is the
digest-pinned trust anchor for the build. Revisit if OSS-Fuzz adds first-class
lockfile support for isolated installs.

## Adding a target

1. Write `fuzz_<name>.js` here (CommonJS; `module.exports.fuzz = async (data) => …`).
2. If it exercises a different module, add that module to the `include` list in
   [`tsconfig.fuzz.json`](./tsconfig.fuzz.json) and import it from
   `../packages/cli/dist-fuzz/`.
3. Add its path to the `paths:` filter in `cflite_pr.yml`.

`build.sh` compiles every `fuzz_*.js` automatically.
