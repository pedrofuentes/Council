/**
 * One-shot re-exec guard that suppresses Node's `node:sqlite`
 * `ExperimentalWarning` by relaunching the process with
 * `--disable-warning=ExperimentalWarning`.
 *
 * Council deliberately uses Node's built-in `node:sqlite` (see
 * `../memory/node-sqlite-dialect.ts`). On macOS/Linux the in-process stderr +
 * `process.emitWarning` filter (`./sqlite-warning-filter.ts`) reliably hides the
 * warning, but on Windows the warning escapes the patched `process.stderr.write`
 * before the filter can drop it. The only OS- and timing-independent way to keep
 * it from ever being printed is to make Node not emit it at all, which the
 * `--disable-warning=ExperimentalWarning` startup flag does.
 *
/**
 * Users typically launch via the explicit `node .../council.js`, so a bin
 * shebang can't carry the flag. Instead we re-exec once, and only when it
 * actually matters — interactively on Windows — so agent/pipe/CI invocations and
 * already-working platforms pay nothing and keep the cheap filter.
 */
import { constants as osConstants } from "node:os";

const REEXEC_SENTINEL_ENV = "COUNCIL_SQLITE_WARNING_REEXEC";
const DISABLE_EXPERIMENTAL_WARNING_FLAG = "--disable-warning=ExperimentalWarning";

/** Generic non-zero exit code when the child failed without a known signal. */
const GENERIC_FAILURE_EXIT_CODE = 1;

export { REEXEC_SENTINEL_ENV, DISABLE_EXPERIMENTAL_WARNING_FLAG };

/** Minimal shape of `spawnSync`'s return value that we depend on. */
interface ReexecSpawnResult {
  readonly status: number | null;
  readonly signal?: NodeJS.Signals | null;
}

/** Options we pass to the injected `spawnSync`. */
interface ReexecSpawnOptions {
  readonly stdio: "inherit";
  readonly env: NodeJS.ProcessEnv;
}

/** The subset of `childProcess.spawnSync` this module uses. */
type ReexecSpawnSync = (
  command: string,
  args: readonly string[],
  options: ReexecSpawnOptions,
) => ReexecSpawnResult;

/** Dependencies, injected so the decision and the spawn are fully testable. */
export interface ReexecDeps {
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly execArgv: readonly string[];
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly scriptPath: string;
  readonly stderrIsTTY: boolean;
  readonly spawnSync: ReexecSpawnSync;
}

/** Outcome of {@link maybeReexecToSuppressSqliteWarning}. */
export interface ReexecResult {
  /** Whether a child process was spawned. When true, the caller should exit. */
  readonly reexeced: boolean;
  /** The child's exit status to propagate (0 when nothing was spawned). */
  readonly status: number;
}

/**
 * Whether the process should re-exec itself with the warning-disabling flag.
 *
 * True only when all hold: we're on Windows (the only platform where the
 * in-process filter leaks), stderr is interactive (so the warning is visible
 * and worth a second process), the flag isn't already active, and we haven't
 * already re-exec'd (guards against an infinite loop).
 */
export function shouldReexecToSuppressSqliteWarning(deps: ReexecDeps): boolean {
  if (deps.platform !== "win32") {
    return false;
  }
  if (!deps.stderrIsTTY) {
    return false;
  }
  if (deps.env[REEXEC_SENTINEL_ENV] === "1") {
    return false;
  }
  if (deps.execArgv.some((arg) => arg.startsWith("--disable-warning"))) {
    return false;
  }
  if ((deps.env.NODE_OPTIONS ?? "").includes("--disable-warning")) {
    return false;
  }
  return true;
}

/**
 * Re-exec the current Node program with `--disable-warning=ExperimentalWarning`
 * when {@link shouldReexecToSuppressSqliteWarning} is true, forwarding the
 * original `execArgv`, the entry script, and the user's CLI arguments and
 * inheriting stdio so the interactive TUI keeps the real terminal.
 *
 * Returns `{ reexeced: false, status: 0 }` (a no-op) when a re-exec isn't
 * warranted; otherwise `{ reexeced: true, status }` carrying the child's exit
 * code for the caller to `process.exit()` with.
 */
/**
 * Translate a `spawnSync` result into the exit code the parent should use.
 *
 * A normal exit gives a numeric `status`. A signal-terminated child reports
 * `status: null` with `signal` set, so we follow the shell convention of
 * `128 + signal number` (e.g. SIGKILL → 137); when the signal is unknown we
 * fall back to a generic non-zero so the parent never masks a failed child as 0.
 */
function reexecExitCode(result: ReexecSpawnResult): number {
  if (result.status !== null) {
    return result.status;
  }
  const signalNumber = result.signal ? osConstants.signals[result.signal] : undefined;
  return signalNumber === undefined ? GENERIC_FAILURE_EXIT_CODE : 128 + signalNumber;
}

export function maybeReexecToSuppressSqliteWarning(deps: ReexecDeps): ReexecResult {
  if (!shouldReexecToSuppressSqliteWarning(deps)) {
    return { reexeced: false, status: 0 };
  }

  const userArgs = deps.argv.slice(2);
  const result = deps.spawnSync(
    deps.execPath,
    [DISABLE_EXPERIMENTAL_WARNING_FLAG, ...deps.execArgv, deps.scriptPath, ...userArgs],
    { stdio: "inherit", env: { ...deps.env, [REEXEC_SENTINEL_ENV]: "1" } },
  );

  return { reexeced: true, status: reexecExitCode(result) };
}
