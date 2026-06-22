# ClusterFuzzLite build image for @council-ai/cli fuzz targets.
#
# The base-builder-javascript image carries the OSS-Fuzz JavaScript toolchain
# (libFuzzer wrappers + `compile_javascript_fuzzer` + Node.js). It is pinned by
# digest rather than a floating tag so OpenSSF Scorecard's Pinned-Dependencies
# check stays satisfied and builds are reproducible. Refresh the digest
# periodically — see .clusterfuzzlite/README.md ("Maintaining the base-image pin").
FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:0588debfb70a08145c31bf744c2ebdd892611679b9cb5689d9c481bf9e11086c

# Copy the whole repo so build.sh can transpile the sanitizer to dist-fuzz/.
COPY . $SRC/council
WORKDIR $SRC/council

# The OSS-Fuzz `compile` entrypoint runs $SRC/build.sh.
COPY .clusterfuzzlite/build.sh $SRC/
