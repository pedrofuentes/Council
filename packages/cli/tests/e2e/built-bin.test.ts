import { execFileSync, execSync, spawn } from "node:child_process";
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

// Once its stdout reader closes, the bundled binary should exit within a couple
// of seconds (the broken-pipe guard calls process.exit); this ceiling only
// guards against a hang and stays under the enclosing 60s Vitest test timeout.
const EARLY_PIPE_CLOSE_TIMEOUT_MS = 30_000;

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
        { cause: error },
      );
    }
    throw error;
  }
}

/** Result of running the bundled CLI with its stdout reader closed early. */
interface EarlyPipeCloseResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

/**
 * Runs the bundled binary with a downstream reader that closes the read end of
 * its stdout pipe immediately — the earliest, most deterministic form of a
 * reader that quits early (`council … | head -1`, `council … | less` then `q`).
 * The child's first stdout write then hits a broken pipe. Resolves with the
 * child's exit code, terminating signal, and captured stderr so a test can
 * assert the process ended cleanly with no unhandled `write EPIPE` stack trace.
 * Kills the child and rejects if it fails to exit within `timeoutMs`.
 */
function runBundledCliWithEarlyStdoutClose(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number = EARLY_PIPE_CLOSE_TIMEOUT_MS,
): Promise<EarlyPipeCloseResult> {
  return new Promise<EarlyPipeCloseResult>((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const { stdout, stderr } = child;
    if (stdout === null || stderr === null) {
      reject(new Error("bundled CLI was spawned without piped stdout/stderr"));
      return;
    }

    let stderrText = "";
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      stderrText += chunk;
    });

    // Close the read end up front so the child's first stdout write hits EPIPE.
    // (Reading a chunk first and only then destroying races the child to
    // completion and is flaky under FORCE_COLOR/CI timing.) Swallow the
    // read-side error this may raise on *our* end of the pipe so the parent
    // test process never crashes; assertions target the *child's* stderr/exit.
    stdout.on("error", () => undefined);
    stdout.destroy();

    const killTimer = setTimeout(() => {
      child.kill(TIMEOUT_KILL_SIGNAL);
      reject(
        new Error(`bundled CLI did not exit within ${timeoutMs}ms after its stdout reader closed`),
      );
    }, timeoutMs);
    killTimer.unref();

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(killTimer);
      resolve({ code, signal, stderr: stderrText });
    });
  });
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

  it("exits cleanly with no EPIPE stack trace when a piped stdout reader closes early", async () => {
    // Piping any command's stdout to a reader that closes early (`… | head -1`,
    // `… | less` then `q`) makes the next stdout write hit a broken pipe. Before
    // the guard existed that surfaced as an unhandled `write EPIPE` "Unhandled
    // 'error' event" crash (exit 1 + Node stack trace). `sessions --format
    // plain` is a representative listing command; a fresh COUNCIL_DATA_HOME just
    // keeps the run self-contained.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "council-epipe-"));
    try {
      const result = await runBundledCliWithEarlyStdoutClose(["sessions", "--format", "plain"], {
        COUNCIL_DATA_HOME: home,
        COUNCIL_NO_TUI: "1",
      });

      expect(result.stderr).not.toContain("EPIPE");
      expect(result.stderr).not.toContain("Unhandled 'error' event");
      expect(result.signal).toBeNull();
      expect(result.code).toBe(0);
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
    ).toThrow(
      "`node <hung script>` timed out after 200ms and was killed (SIGKILL); the child process likely hung.",
    );
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
