import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["node_modules", "dist", ".worktrees"],
    environment: "node",
    globals: false,
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
