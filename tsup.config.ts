import { defineConfig } from "tsup";

/**
 * Two entries with different banner needs:
 *   - `src/index.ts` (library)  → NO shebang
 *   - `src/bin/council.ts` (bin) → MUST have shebang
 *
 * tsup's top-level `banner` applies to every entry, so we declare two
 * separate build configs in the array form. tsup runs them sequentially
 * with the same `outDir`.
 */
export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    shims: false,
    treeshake: true,
    platform: "node",
  },
  {
    entry: { "bin/council": "src/bin/council.ts" },
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    dts: true,
    sourcemap: true,
    clean: false, // do not wipe the library output produced above
    splitting: false,
    shims: false,
    treeshake: true,
    platform: "node",
    banner: { js: "#!/usr/bin/env node" },
  },
]);
