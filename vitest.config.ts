import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules", "dist", ".worktrees"],
    environment: "node",
    globals: false,
    // Default 5000ms is too tight under maximal parallel worker load
    // (several CLI command tests legitimately spawn child processes and
    // each takes ~1.5–2s). Raise the ceiling so genuine slowness doesn't
    // present as flake on busy machines.
    testTimeout: 15000,
    hookTimeout: 15000,
    // Per-process test isolation: tests/setup.ts redirects COUNCIL_HOME
    // to a per-process temp dir so commands that touch the filesystem
    // cannot pollute the user's real ~/.council/ directory.
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/types.ts", "src/bin/**"],
      // Thresholds will be enabled in PR #2 once behavior-bearing code lands.
      // See ROADMAP §1.2 (CouncilEngine interface).
    },
  },
});
