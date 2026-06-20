import { defineConfig } from "vitest/config";

const isCI = !!process.env.CI;

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules", "dist", ".worktrees"],
    environment: "node",
    globals: false,

    // Build a pre-migrated template DB once before any worker starts.
    // Workers copy this template (via `copyTemplateDb()`) instead of
    // running the migration per `createDatabase()` call.
    globalSetup: ["./tests/global-setup.ts"],

    // Use forked child processes (not worker threads). The SQLite file handles
    // node:sqlite owns must be owned by a single OS process for clean teardown
    // on Windows. `forks` is the Vitest default, but we make it explicit so a
    // future Vitest default change cannot silently break us.
    pool: "forks",

    // Cap parallelism. On Windows, too many concurrent forks thrash
    // os.tmpdir() (SQLite file creation, rm -rf, handle release) — the
    // dominant source of EBUSY/EPERM flakes and "Worker exited unexpectedly"
    // crashes. A 16-core machine at "50%" spawns 8 workers; empirically,
    // 4 is the sweet spot that keeps throughput high without triggering
    // NTFS handle contention. CI gets 2 (sharding handles parallelism).
    maxWorkers: isCI ? 2 : 4,

    // Isolate every test file in its own fork. This is the default for
    // pool: "forks", but is stated explicitly so the guarantee — no shared
    // module state, no leaked SQLite handles between files — is visible to
    // anyone reading this config.
    isolate: true,

    // Timeouts sized for full-suite contention on Windows. Hooks (beforeEach)
    // do DB setup and are most affected by disk I/O contention, so they get
    // a wider window than test bodies. Per-test overrides exist for tests
    // that spawn child processes or contend on SQLite write locks.
    testTimeout: 20_000,
    hookTimeout: 30_000,

    // Bounded retry for transient Windows subprocess-timeout flakes (#860/#972/#863/#936).
    // Windows-only so the Ubuntu CI signal is never masked. retry re-runs ONLY failed
    // tests, so green tests are unaffected and a deterministic failure still exhausts all
    // retries (a real bug is NOT hidden — it just runs a few extra times before failing).
    retry: process.platform === "win32" ? 2 : 0,

    // Per-process test isolation: tests/setup.ts redirects COUNCIL_HOME
    // to a per-process temp dir so commands that touch the filesystem
    // cannot pollute the user's real ~/.council/ directory.
    setupFiles: ["./tests/setup.ts"],

    // --- Performance tuning ---

    // Cache transformed modules on the filesystem. On reruns (iterative
    // dev), Vitest skips re-transforming unchanged files — measured at ~79%
    // transform reduction and ~57% import reduction in Vitest benchmarks.
    // Requires Vitest 4.0.11+ (we run 4.1.6).
    experimental: {
      fsModuleCache: true,
    },

    // In CI, stop on the first test failure within a shard — the aggregate
    // gate will mark the run as failed regardless, so there's no value in
    // running the remaining tests. Locally, run everything so the developer
    // sees all failures at once.
    bail: isCI ? 1 : 0,

    // In CI, use the dot reporter for lighter output overhead.
    // Locally, use the default reporter for readable test names.
    reporters: isCI ? ["dot"] : ["default"],

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
