import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "bin/council": "src/bin/council.ts",
  },
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  shims: false,
  treeshake: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Only the bin entry needs the shebang; tsup applies banner to all entries.
  // We strip it from non-bin entries via the `esbuildOptions` hook below.
  esbuildOptions(options, _context) {
    options.platform = "node";
  },
});
