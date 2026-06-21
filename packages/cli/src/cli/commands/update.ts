/**
 * `council update` — upgrade the globally-installed `council-ai` CLI to the
 * latest published version.
 *
 * The command detects the package manager that owns the install (npm, pnpm,
 * yarn, or bun), shows the exact command it intends to run, and — unless
 * `--yes` is given — asks for confirmation before shelling out. The upgrade is
 * executed via `execFile` with an argv array (NEVER a shell string) and a
 * fixed literal package spec, so no untrusted input is ever interpolated into
 * the spawned command.
 */
import { execFile, type ExecFileException } from "node:child_process";

import { Command } from "commander";

import packageJson from "../../../package.json" with { type: "json" };

import { fetchLatestVersion, isNewerVersion } from "../../core/version/index.js";
import { CliUserError } from "../cli-user-error.js";
import { EXIT_INTERNAL_ERROR, EXIT_NETWORK_ERROR } from "../exit-codes.js";
import { createSpinner, type Spinner, type SpinnerOptions } from "../renderers/spinner.js";
import { toSingleLineDisplay } from "../strip-control-chars.js";

import { createReadlineConfirmProvider, type ConfirmProvider } from "./confirm.js";
import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";

/** The package managers Council knows how to drive for a global upgrade. */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Allow-list used both for detection results and `--pm` validation. */
const PACKAGE_MANAGERS: readonly PackageManager[] = ["npm", "pnpm", "yarn", "bun"];

/**
 * The fixed, literal package spec passed to the package manager. It is a
 * compile-time constant — never built from user input — so the spawned command
 * can never be influenced by untrusted data.
 */
const PACKAGE_SPEC = "council-ai@latest";

/** Result of running the package manager's global-install command. */
export type UpgradeRunResult =
  | {
      /** Process exited normally (possibly with a non-zero status). */
      readonly kind?: "exit";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      /** Parent killed the child after exceeding the configured timeout. */
      readonly kind: "timeout";
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      /** Child was terminated by a signal (e.g. an external SIGKILL). */
      readonly kind: "signal";
      readonly signal: string;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      /** Child produced more output than `maxBuffer` allows. */
      readonly kind: "maxBuffer";
      readonly stdout: string;
      readonly stderr: string;
    };

/**
 * How long to wait for a global install before giving up. A real
 * `npm i -g` is usually well under a minute, but slow networks and large
 * dependency trees can take longer — five minutes is generous without
 * letting a wedged package manager hang `council update` forever.
 */
export const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Upper bound on captured stdout/stderr. Node's `execFile` default is 1 MiB,
 * which a chatty `npm i -g` can exceed — at which point Node kills the child
 * and reports failure even though the install would have succeeded. 64 MiB is
 * far above any realistic global-install transcript.
 */
export const UPDATE_MAX_BUFFER = 64 * 1024 * 1024;

/** Node's error code when a child exceeds the configured `maxBuffer`. */
const MAXBUFFER_ERROR_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

/**
 * Runs the package manager with the given argv array and resolves with a
 * classified outcome (clean/non-zero exit, timeout, signal kill, or maxBuffer
 * overflow). Rejects only when the process cannot be spawned at all (e.g. the
 * binary is missing).
 */
export type UpgradeRunner = (
  pm: PackageManager,
  args: readonly string[],
) => Promise<UpgradeRunResult>;

/** Best-effort signals used to detect which package manager owns the install. */
export interface DetectPackageManagerSources {
  /** Typically `process.env.npm_config_user_agent`. */
  readonly userAgent?: string | undefined;
  /** Typically `process.argv0` / the running binary's path. */
  readonly execPath?: string | undefined;
}

/** Narrowing type guard for the `--pm` allow-list. */
export function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

function detectFromUserAgent(userAgent: string): PackageManager | null {
  for (const pm of PACKAGE_MANAGERS) {
    if (userAgent.startsWith(`${pm}/`)) {
      return pm;
    }
  }
  return null;
}

function detectFromExecPath(execPath: string): PackageManager | null {
  const segments = execPath.toLowerCase().split(/[\\/]+/);
  if (segments.includes("pnpm") || segments.includes(".pnpm")) {
    return "pnpm";
  }
  if (segments.includes("yarn") || segments.includes(".yarn")) {
    return "yarn";
  }
  if (segments.includes("bun") || segments.includes(".bun")) {
    return "bun";
  }
  return null;
}

/**
 * Best-effort detection of the package manager that installed this CLI. Prefers
 * `npm_config_user_agent`, then falls back to path heuristics on the running
 * binary, and defaults to `npm` when nothing conclusive is found.
 */
export function detectPackageManager(sources: DetectPackageManagerSources = {}): PackageManager {
  const userAgent = sources.userAgent ?? "";
  const fromUserAgent = detectFromUserAgent(userAgent);
  if (fromUserAgent !== null) {
    return fromUserAgent;
  }

  const execPath = sources.execPath ?? "";
  const fromPath = detectFromExecPath(execPath);
  if (fromPath !== null) {
    return fromPath;
  }

  return "npm";
}

/** Maps a package manager to its global-install argv array (no shell string). */
export function buildUpgradeArgs(pm: PackageManager): readonly string[] {
  switch (pm) {
    case "npm":
      return ["install", "-g", PACKAGE_SPEC];
    case "pnpm":
      return ["add", "-g", PACKAGE_SPEC];
    case "yarn":
      return ["global", "add", PACKAGE_SPEC];
    case "bun":
      return ["add", "-g", PACKAGE_SPEC];
  }
}

/**
 * Classifies the result of an `execFile` callback into a discriminated
 * {@link UpgradeRunResult}. Throws the original error only for genuine spawn
 * failures (e.g. `ENOENT` when the package manager is not installed), so
 * callers can report "not installed" without mislabelling a signal/maxBuffer
 * termination.
 */
export function classifyExecFileResult(
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
): UpgradeRunResult {
  if (error === null) {
    return { kind: "exit", exitCode: 0, stdout, stderr };
  }

  const code = error.code;
  if (typeof code === "number") {
    return { kind: "exit", exitCode: code, stdout, stderr };
  }

  if (code === MAXBUFFER_ERROR_CODE) {
    return { kind: "maxBuffer", stdout, stderr };
  }

  const signal = error.signal ?? null;
  if (signal !== null) {
    // `killed` is true only when the parent sent the signal — i.e. our own
    // timeout fired. An external SIGKILL/SIGTERM leaves `killed` false.
    if (error.killed === true) {
      return { kind: "timeout", stdout, stderr };
    }
    return { kind: "signal", signal, stdout, stderr };
  }

  // No numeric code and no signal → the process could not be spawned at all.
  throw error;
}

const defaultRunner: UpgradeRunner = (pm, args) =>
  new Promise<UpgradeRunResult>((resolve, reject) => {
    execFile(
      pm,
      [...args],
      {
        windowsHide: true,
        encoding: "utf8",
        timeout: UPDATE_TIMEOUT_MS,
        maxBuffer: UPDATE_MAX_BUFFER,
        killSignal: "SIGTERM",
      },
      (error, stdout, stderr) => {
        try {
          resolve(classifyExecFileResult(error, stdout, stderr));
        } catch (spawnError) {
          reject(spawnError instanceof Error ? spawnError : new Error(String(spawnError)));
        }
      },
    );
  });

export interface UpdateCommandDeps {
  readonly fetchLatest?: typeof fetchLatestVersion;
  readonly runner?: UpgradeRunner;
  readonly write?: Writer;
  readonly writeError?: Writer;
  readonly confirmProvider?: () => ConfirmProvider;
  readonly createSpinner?: (opts?: SpinnerOptions) => Spinner;
  readonly currentVersion?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
}

interface UpdateOptions {
  readonly pm?: string;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
}

function failUpdate(
  writeError: Writer,
  message: string,
  exitCode: number = EXIT_INTERNAL_ERROR,
): never {
  writeError(`Error: ${message}\n`);
  const err = new CliUserError("council update failed");
  err.exitCode = exitCode;
  throw err;
}

/**
 * Picks the most useful captured output to show the user, with a fallback.
 *
 * The package manager runs as an untrusted subprocess: a verbose or
 * supply-chain-compromised manager could emit ANSI/OSC/Bidi control bytes that,
 * written verbatim to the terminal, clear the screen, forge a "success" line,
 * set the title/clipboard, or visually reorder text (Trojan Source). Both
 * stdout and stderr are therefore sanitized and collapsed onto a single line
 * via {@link toSingleLineDisplay} before selection, so every error branch
 * surfaces only inert, single-line text. The fallback is a trusted constant.
 */
function outputDetail(stdout: string, stderr: string, fallback: string): string {
  const safeStderr = toSingleLineDisplay(stderr).trim();
  const safeStdout = toSingleLineDisplay(stdout).trim();
  return safeStderr || safeStdout || fallback;
}

export function buildUpdateCommand(deps: UpdateCommandDeps = {}): Command {
  const fetchLatest = deps.fetchLatest ?? fetchLatestVersion;
  const runner = deps.runner ?? defaultRunner;
  const write = deps.write ?? defaultWriter;
  const writeError = deps.writeError ?? defaultErrorWriter;
  const confirmProvider = deps.confirmProvider ?? createReadlineConfirmProvider;
  const makeSpinner = deps.createSpinner ?? createSpinner;
  const currentVersion = deps.currentVersion ?? packageJson.version;
  const env = deps.env ?? process.env;
  const execPath = deps.execPath ?? process.argv0;

  const cmd = new Command("update");
  cmd
    .description("Upgrade the globally-installed Council CLI to the latest version")
    .option("--pm <name>", "Package manager to use (npm, pnpm, yarn, bun)")
    .option("-y, --yes", "Skip the confirmation prompt")
    .option("--dry-run", "Print the upgrade command without running it")
    .action(async (options: UpdateOptions) => {
      let pm: PackageManager;
      if (options.pm !== undefined) {
        if (!isPackageManager(options.pm)) {
          writeError(
            `Error: unknown package manager "${options.pm}". Expected one of: ${PACKAGE_MANAGERS.join(
              ", ",
            )}.\n`,
          );
          throw new CliUserError("invalid --pm value");
        }
        pm = options.pm;
      } else {
        pm = detectPackageManager({
          userAgent: env["npm_config_user_agent"],
          execPath,
        });
      }

      const latest = await fetchLatest();
      if (latest === null) {
        failUpdate(
          writeError,
          "couldn't check for updates \u2014 the package registry is unreachable. Please check your connection and try again later.",
          EXIT_NETWORK_ERROR,
        );
      }

      if (!isNewerVersion(currentVersion, latest)) {
        write(`Council is already up to date (v${currentVersion}).\n`);
        return;
      }

      const args = buildUpgradeArgs(pm);
      const commandLine = `${pm} ${args.join(" ")}`;
      write(`Update available: v${currentVersion} \u2192 v${latest}\n`);
      write(`Will run: ${commandLine}\n`);

      if (options.dryRun === true) {
        write("Dry run \u2014 no changes made.\n");
        return;
      }

      if (options.yes !== true) {
        const confirmed = await confirmProvider().confirm(`Update Council to v${latest}? [y/N] `);
        if (!confirmed) {
          writeError("Aborted.\n");
          return;
        }
      }

      const spinner = makeSpinner();
      let result: UpgradeRunResult;
      spinner.start("Updating");
      try {
        result = await runner(pm, args);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        failUpdate(writeError, `failed to run "${commandLine}": ${message}`);
      } finally {
        spinner.stop();
      }

      if (result.kind === "timeout") {
        const minutes = Math.round(UPDATE_TIMEOUT_MS / 60000);
        failUpdate(
          writeError,
          `"${commandLine}" timed out after ${minutes} minute(s) and was terminated. The package manager may be stuck or the network may be slow.\n${outputDetail(
            result.stdout,
            result.stderr,
            "no output was captured before the timeout",
          )}`,
        );
      }

      if (result.kind === "signal") {
        failUpdate(
          writeError,
          `"${commandLine}" was terminated by signal ${result.signal} before it finished.\n${outputDetail(
            result.stdout,
            result.stderr,
            "no output was captured before the process was killed",
          )}`,
        );
      }

      if (result.kind === "maxBuffer") {
        failUpdate(
          writeError,
          `"${commandLine}" produced more output than Council can buffer and was terminated. Try running the upgrade command manually.\n${outputDetail(
            result.stdout,
            result.stderr,
            "no output was captured",
          )}`,
        );
      }

      if (result.exitCode !== 0) {
        failUpdate(
          writeError,
          `"${commandLine}" failed:\n${outputDetail(
            result.stdout,
            result.stderr,
            `exited with code ${result.exitCode}`,
          )}`,
        );
      }

      write(
        `Updated v${currentVersion} \u2192 v${latest} \u2014 restart council to use the new version.\n`,
      );
    });
  return cmd;
}
