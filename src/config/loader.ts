/**
 * Configuration loader.
 *
 * Resolution rules:
 *   1. Council home directory:
 *        - `process.env.COUNCIL_HOME` if set (used by --ephemeral mode and tests)
 *        - Else `~/.council`
 *   2. Config file: `<home>/config.yaml`
 *   3. If the file is missing, write the schema defaults and continue.
 *   4. If the file exists, parse YAML, validate via ConfigSchema, return typed
 *      CouncilConfig. Validation errors include the offending path + reason.
 *
 * Designed to be called from CLI commands and from `council doctor`. Never
 * throws on a missing home directory — creates it.
 */
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as yaml from "yaml";
import type { ZodError } from "zod";

import { ConfigSchema, type CouncilConfig, type EngineChoice } from "./schema.js";

const CONFIG_FILE = "config.yaml";

/**
 * Resolve the directory that holds Council's runtime data.
 * Honors `COUNCIL_HOME`, then falls back to `COUNCIL_DATA_HOME` so a single
 * env-var override can relocate both runtime and library data together.
 */
export function getCouncilHome(): string {
  const envHome = process.env["COUNCIL_HOME"];
  if (envHome && envHome.length > 0) return envHome;

  const envDataHome = process.env["COUNCIL_DATA_HOME"];
  if (envDataHome && envDataHome.length > 0) return envDataHome;

  return path.join(os.homedir(), ".council");
}

/**
 * Resolve the user-facing data directory for Council expert/panel YAML.
 * Honors `COUNCIL_DATA_HOME` env var for test isolation. Falls back to
 * `config.paths.dataHome` (with `~` expansion), then `~/Council`.
 *
 * Kept separate from `getCouncilHome()` so the visible YAML library
 * (`~/Council/`) is distinct from the hidden runtime dir (`~/.council/`).
 */
export function getCouncilDataHome(config?: CouncilConfig): string {
  const envHome = process.env["COUNCIL_DATA_HOME"];
  if (envHome && envHome.length > 0) return envHome;
  if (config?.paths?.dataHome) {
    const dataHome = config.paths.dataHome;
    if (dataHome === "~") return os.homedir();
    if (dataHome.startsWith("~/")) {
      return path.join(os.homedir(), dataHome.slice(2));
    }
    return dataHome;
  }
  return path.join(os.homedir(), "Council");
}

/**
 * Ensure the user-facing data directories exist. Creates
 * `<dataHome>/experts/` and `<dataHome>/panels/` if missing. Idempotent.
 */
export async function ensureDataDirectories(dataHome: string): Promise<void> {
  await fs.mkdir(path.join(dataHome, "experts"), { recursive: true });
  await fs.mkdir(path.join(dataHome, "panels"), { recursive: true });
}

function configPath(): string {
  return path.join(getCouncilHome(), CONFIG_FILE);
}

async function ensureHomeDirectory(): Promise<void> {
  await fs.mkdir(getCouncilHome(), { recursive: true });
}

async function writeDefaultConfig(): Promise<CouncilConfig> {
  const defaults: CouncilConfig = ConfigSchema.parse({});
  const yamlText = yaml.stringify(defaults);
  const banner =
    "# Council configuration\n" +
    "# See https://github.com/pedrofuentes/Council for documentation.\n" +
    "# Edit values below; missing fields use built-in defaults.\n\n";
  await fs.writeFile(configPath(), banner + yamlText, "utf-8");
  return defaults;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withConfigLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const maxRetries = 50;
  const retryDelay = 100;
  let handle: FileHandle | undefined;

  for (let index = 0; index < maxRetries; index += 1) {
    try {
      handle = await fs.open(lockPath, "wx");
      break;
    } catch (err: unknown) {
      // EEXIST: lock held by another caller.
      // EPERM / EACCES: transient Windows NTFS contention during
      // concurrent open/close/unlink of the lock file (#820).
      if (
        hasErrorCode(err, "EEXIST") ||
        hasErrorCode(err, "EPERM") ||
        hasErrorCode(err, "EACCES")
      ) {
        await sleep(retryDelay);
        continue;
      }
      throw err;
    }
  }

  if (handle === undefined) {
    throw new Error(`Could not acquire config lock after ${maxRetries} retries`);
  }

  try {
    return await fn();
  } finally {
    await handle.close();
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

function formatZodError(err: ZodError, source: string): Error {
  const lines = err.issues.map((i) => {
    const fieldPath = i.path.length > 0 ? i.path.join(".") : "(root)";
    return `  - ${fieldPath}: ${i.message}`;
  });
  return new Error(`Invalid Council config in ${source}:\n${lines.join("\n")}`);
}

/**
 * Load (or create) the Council config file.
 * Always returns a fully-defaulted CouncilConfig.
 */
export async function loadConfig(): Promise<CouncilConfig> {
  const { config } = await loadConfigWithMeta();
  return config;
}

/**
 * Extended config loader that also reports whether this was a first-run
 * (config file was just created). Used by CLI entry points that want to
 * show the welcome banner exactly once.
 */
export interface ConfigLoadResult {
  readonly config: CouncilConfig;
  readonly isFirstRun: boolean;
}

export async function loadConfigWithMeta(): Promise<ConfigLoadResult> {
  await ensureHomeDirectory();
  const file = configPath();

  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err: unknown) {
    if (isENOENT(err)) {
      const config = await writeDefaultConfig();
      return { config, isFirstRun: true };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse Council config (${file}): ${cause}`);
  }

  // Empty file -> empty object -> defaults
  const input: unknown = parsed ?? {};

  const result = ConfigSchema.safeParse(input);
  if (!result.success) {
    throw formatZodError(result.error, file);
  }
  return { config: result.data, isFirstRun: false };
}

/**
 * Update a single dot-notation field inside config.yaml, validating the full
 * document before writing any changes back to disk.
 */
export async function updateConfigField(
  key: string,
  value: string | number | boolean | readonly string[],
): Promise<void> {
  await ensureHomeDirectory();
  const file = configPath();
  const lockPath = `${file}.lock`;

  await withConfigLock(lockPath, async () => {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf-8");
    } catch (err: unknown) {
      if (isENOENT(err)) {
        await writeDefaultConfig();
        raw = await fs.readFile(file, "utf-8");
      } else {
        throw err;
      }
    }

    const document = yaml.parseDocument(raw);
    if (document.errors.length > 0) {
      const cause = document.errors.map((err) => err.message).join("; ");
      throw new Error(`Failed to parse Council config (${file}): ${cause}`);
    }

    if (document.contents === null) {
      document.contents = yaml.parseDocument("{}").contents;
    } else if (!yaml.isMap(document.contents)) {
      throw new Error(
        `Council config (${file}) has an invalid root structure. Expected a YAML mapping but found ${document.contents.constructor.name}. Please fix or delete the config file.`,
      );
    }

    document.setIn(key.split("."), value);

    const result = ConfigSchema.safeParse(document.toJS() ?? {});
    if (!result.success) {
      throw formatZodError(result.error, file);
    }

    const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpFile, document.toString(), "utf-8");
    try {
      await fs.rename(tmpFile, file);
    } catch (renameErr) {
      await fs.unlink(tmpFile).catch(() => undefined);
      throw renameErr;
    }
  });
}

/**
 * Resolve the engine to use given an optional CLI flag and a loaded config.
 * Resolution order: CLI flag → config file → default "copilot".
 */
export function resolveEngine(
  cliFlag: EngineChoice | undefined,
  config: CouncilConfig,
): EngineChoice {
  if (cliFlag !== undefined) return cliFlag;
  return config.defaults.engine;
}

function hasErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}

function isENOENT(err: unknown): boolean {
  return hasErrorCode(err, "ENOENT");
}
