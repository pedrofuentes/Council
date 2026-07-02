import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * Smoke test for the **bundled** CLI (`dist/bin/council.js`), not the source.
 *
 * The rest of the e2e suite imports command builders from `src/` and runs them
 * in-process, so it never exercises tsup's esbuild output. esbuild strips the
 * mandatory `node:` prefix from `node:sqlite` (Node has no bare `sqlite`
 * builtin), which crashed the published binary at startup with
 * `Cannot find package 'sqlite'`. This test builds the package and runs the
 * real bundled binary so that regression is caught in CI.
 */
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const binPath = path.join(pkgRoot, "dist", "bin", "council.js");

// Explicit child-process timeouts (#1272): without a `timeout` option, a hung
// `pnpm run build` or a hung bundled binary would only stop once Vitest's own
// hook/test timeouts fire (180s / 60s below) — slow, and Vitest's "hook timed
// out" message doesn't identify which child process actually stalled. Each
// value here is kept comfortably under its enclosing Vitest timeout so the
// child-level failure fires first, with a message that names the command.
const BUILD_TIMEOUT_MS = 150_000;
const DOCTOR_TIMEOUT_MS = 45_000;
const TIMEOUT_KILL_SIGNAL = "SIGKILL";

/** Narrows an unknown catch value to Node's `ETIMEDOUT` child-process error shape. */
function isChildProcessTimeout(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ETIMEDOUT"
  );
}

/**
 * Runs a synchronous child-process invocation and rethrows timeout failures
 * with a message identifying the command and configured limit, instead of
 * Node's generic `spawnSync ... ETIMEDOUT`. Non-timeout errors propagate
 * unchanged so real failures (e.g. a non-zero exit code) keep their original
 * diagnostics.
 */
function runChildProcess<T>(label: string, timeoutMs: number, invoke: () => T): T {
  try {
    return invoke();
  } catch (error: unknown) {
    if (isChildProcessTimeout(error)) {
      throw new Error(
        `${label} timed out after ${timeoutMs}ms and was killed (${TIMEOUT_KILL_SIGNAL}); ` +
          "the child process likely hung.",
      );
    }
    throw error;
  }
}

describe("bundled CLI binary", () => {
  beforeAll(() => {
    runChildProcess("`pnpm run build`", BUILD_TIMEOUT_MS, () =>
      execSync("pnpm run build", {
        cwd: pkgRoot,
        stdio: "pipe",
        timeout: BUILD_TIMEOUT_MS,
        killSignal: TIMEOUT_KILL_SIGNAL,
      }),
    );
  }, 180_000);

  it("runs `doctor --offline` from dist (node:sqlite resolves in the bundle)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "council-built-bin-"));
    try {
      const stdout = runChildProcess("`council doctor --offline`", DOCTOR_TIMEOUT_MS, () =>
        execFileSync(process.execPath, [binPath, "doctor", "--offline"], {
          encoding: "utf8",
          env: { ...process.env, COUNCIL_DATA_HOME: home },
          timeout: DOCTOR_TIMEOUT_MS,
          killSignal: TIMEOUT_KILL_SIGNAL,
        }),
      );

      expect(stdout).toContain("SQLite (node:sqlite)");
      expect(stdout).toContain("All checks passed");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("runChildProcess timeout handling (#1272)", () => {
  it("fails fast with a clear message when a child process hangs past its timeout", () => {
    expect(() =>
      runChildProcess("`node <hung script>`", 200, () =>
        execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
          timeout: 200,
          killSignal: TIMEOUT_KILL_SIGNAL,
        }),
      ),
    ).toThrow("`node <hung script>` timed out after 200ms and was killed (SIGKILL); the child process likely hung.");
  });

  it("propagates non-timeout errors unchanged (e.g. a non-zero exit code)", () => {
    expect(() =>
      runChildProcess("`node <failing script>`", 5_000, () =>
        execFileSync(process.execPath, ["-e", "process.exit(1)"], {
          timeout: 5_000,
          killSignal: TIMEOUT_KILL_SIGNAL,
        }),
      ),
    ).toThrow(/Command failed/);
  });
});
