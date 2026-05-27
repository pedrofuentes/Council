import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules", "dist", ".worktrees"],
    environment: "node",
    globals: false,

    // Build a pre-migrated template DB once before any worker starts.
    // Workers copy this template (via `copyTemplateDb()`) instead of
    // running 11 sequential migrations per `createDatabase()` call.
    globalSetup: ["./tests/global-setup.ts"],

    // Use forked child processes (not worker threads). @libsql/client loads a
    // native binding that is not safe to share across worker_threads, and the
    // SQLite file handles it owns must be owned by a single OS process for
    // clean teardown on Windows. `forks` is the Vitest default, but we make it
    // explicit so a future Vitest default change cannot silently break us.
    pool: "forks",

    // Cap parallelism. On Windows CI, too many concurrent forks thrash
    // os.tmpdir() (SQLite file creation, rm -rf, handle release) which is the
    // dominant source of EBUSY/EPERM flakes. Locally "50%" keeps developer
    // machines responsive; CI gets a hard cap of 2.
    maxWorkers: process.env.CI ? 2 : "50%",

    // Isolate every test file in its own fork. This is the default for
    // pool: "forks", but is stated explicitly so the guarantee — no shared
    // module state, no leaked SQLite handles between files — is visible to
    // anyone reading this config.
    isolate: true,

    // 15s accommodates Windows fork startup + libsql native binding load +
    // migration runs (~5s for 11 migrations) on a cold worker, plus the CLI
    // command tests that spawn child processes (~1.5–2s each). Per-test
    // timeouts in tests/unit/memory/db-and-repos.test.ts override this for
    // tests that spawn a child process AND contend on a SQLite write lock.
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
