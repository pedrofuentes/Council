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
    target: "node24",
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
    target: "node24",
    outDir: "dist",
    dts: true,
    sourcemap: true,
    clean: false, // do not wipe the library output produced above
    splitting: false,
    shims: false,
    treeshake: true,
    platform: "node",
    onSuccess: async () => {
      // esbuild normalizes `node:sqlite` to a bare `sqlite` import (Node has no
      // `sqlite` builtin without the prefix), which crashes the bundled CLI at
      // startup with "Cannot find package 'sqlite'". Restore the prefix in the
      // emitted bundles. Guarded by tests/e2e/built-bin.test.ts.
      const { readFile, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      for (const file of ["dist/index.js", "dist/bin/council.js"]) {
        const filePath = join(process.cwd(), file);
        const original = await readFile(filePath, "utf8");
        const patched = original
          .replace(/from(\s*)(["'])sqlite\2/g, "from$1$2node:sqlite$2")
          .replace(/import\((\s*)(["'])sqlite\2(\s*)\)/g, "import($1$2node:sqlite$2$3)");
        if (patched !== original) {
          await writeFile(filePath, patched);
        }
      }
    },
    banner: { js: "#!/usr/bin/env node" },
  },
]);
