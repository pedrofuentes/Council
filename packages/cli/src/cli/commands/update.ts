/**
 * `council update` — upgrade the globally-installed `@council-ai/cli` to the
 * latest published version.
 *
 * The command detects the package manager that owns the install (npm, pnpm,
 * yarn, or bun), shows the exact command it intends to run, and — unless
 * `--yes` is given — asks for confirmation before shelling out. The upgrade is
 * executed via `execFile` with an argv array (NEVER a shell string) and a
 * fixed literal package spec, so no untrusted input is ever interpolated into
 * the spawned command.
 */
import { execFile } from "node:child_process";

import { Command } from "commander";

import packageJson from "../../../package.json" with { type: "json" };

import { fetchLatestVersion, isNewerVersion } from "../../core/version/index.js";
import { CliUserError } from "../cli-user-error.js";
import { EXIT_INTERNAL_ERROR } from "../exit-codes.js";
import { createSpinner, type Spinner, type SpinnerOptions } from "../renderers/spinner.js";

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
const PACKAGE_SPEC = "@council-ai/cli@latest";

/** Result of running the package manager's global-install command. */
export interface UpgradeRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the package manager with the given argv array and resolves with its
 * exit code and captured output. Rejects only when the process cannot be
 * spawned at all (e.g. the binary is missing).
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

const defaultRunner: UpgradeRunner = (pm, args) =>
  new Promise<UpgradeRunResult>((resolve, reject) => {
    execFile(pm, [...args], { windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ exitCode: 0, stdout, stderr });
        return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (typeof code === "number") {
        resolve({ exitCode: code, stdout, stderr });
        return;
      }
      // No numeric exit code → the process could not be spawned at all
      // (e.g. ENOENT when the package manager is not installed).
      reject(error);
    });
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

function failUpdate(writeError: Writer, message: string): never {
  writeError(`Error: ${message}\n`);
  const err = new CliUserError("council update failed");
  err.exitCode = EXIT_INTERNAL_ERROR;
  throw err;
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
        writeError("Couldn't check for the latest version. Please try again later.\n");
        return;
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

      if (result.exitCode !== 0) {
        const detail =
          result.stderr.trim() || result.stdout.trim() || `exited with code ${result.exitCode}`;
        failUpdate(writeError, `"${commandLine}" failed:\n${detail}`);
      }

      write(
        `Updated v${currentVersion} \u2192 v${latest} \u2014 restart council to use the new version.\n`,
      );
    });
  return cmd;
}
