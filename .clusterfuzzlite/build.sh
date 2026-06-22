#!/bin/bash -eu
#
# ClusterFuzzLite build script for @council-ai/cli fuzz targets.
#
# Runs inside gcr.io/oss-fuzz-base/base-builder-javascript via the OSS-Fuzz
# `compile` entrypoint. It transpiles the self-contained terminal sanitizer to
# ESM JavaScript, makes Jazzer.js resolvable, and wraps each fuzz target into a
# libFuzzer binary in $OUT.
#
# The function under test (packages/cli/src/cli/strip-control-chars.ts and its
# only import, hidden-format-chars.ts) has ZERO runtime dependencies, so this
# script never reconciles the repo's pnpm workspace with npm — it installs the
# TypeScript compiler and Jazzer.js in isolated temp dirs instead. That avoids
# both pnpm's symlinked store (which compile_javascript_fuzzer cannot copy into
# $OUT) and rebuilding the workspace's Jazzer.js (see the version note below).

SRC_DIR="$SRC/council"
cd "$SRC_DIR"

# 1. Transpile the sanitizer to ESM JS in packages/cli/dist-fuzz/. Install only
#    the TypeScript compiler (zero-dependency, pinned to the repo's version) in
#    an isolated dir, then emit with the dedicated standalone tsconfig. Paths in
#    that tsconfig are resolved relative to the config file, so the output lands
#    in packages/cli/dist-fuzz/ regardless of the compiler's location.
TS_VERSION="$(node -p "require('./package.json').devDependencies.typescript")"
TS_DIR="$(mktemp -d)"
( cd "$TS_DIR" && npm install --no-save --no-audit --no-fund --ignore-scripts "typescript@${TS_VERSION}" )
"$TS_DIR/node_modules/.bin/tsc" -p "$SRC_DIR/.clusterfuzzlite/tsconfig.fuzz.json"
rm -rf "$TS_DIR"

# 2. Make @jazzer.js/core resolvable for the CommonJS fuzz targets. Install it
#    in isolation, then overlay it into the project's node_modules so the
#    targets' require("@jazzer.js/core") resolves and compile_javascript_fuzzer
#    copies it into $OUT.
#
#    Pinned to 2.1.0: its prebuilt native addon links against glibc 2.31 (the
#    OSS-Fuzz base image's floor), so it loads on that image and on any newer
#    glibc. Jazzer.js 4.x ships a prebuilt that requires GLIBC_2.32 and fails to
#    dlopen on the 2.31 base. The repo's devDependency tracks 4.x for local
#    runs (macOS/modern Linux); the FuzzedDataProvider API the targets use is
#    identical across both. Bump this pin once the OSS-Fuzz base moves to a
#    newer glibc — see .clusterfuzzlite/README.md.
JAZZER_DIR="$(mktemp -d)"
( cd "$JAZZER_DIR" && npm install --no-save --no-audit --no-fund "@jazzer.js/core@2.1.0" )
mkdir -p "$SRC_DIR/node_modules"
# Clobbering copy so the pinned Jazzer.js deterministically wins over anything a
# non-clean checkout might have left behind.
cp -r "$JAZZER_DIR"/node_modules/. "$SRC_DIR/node_modules/"
rm -rf "$JAZZER_DIR"

# 3. Bundle every fuzz target into a standalone libFuzzer binary in $OUT.
#    compile_javascript_fuzzer follows each CommonJS target's dynamic import()
#    of the transpiled ESM sanitizer in packages/cli/dist-fuzz/.
for target_path in "$SRC_DIR"/.clusterfuzzlite/fuzz_*.js; do
  target_name="$(basename "$target_path" .js)"
  compile_javascript_fuzzer council ".clusterfuzzlite/${target_name}.js"
done
