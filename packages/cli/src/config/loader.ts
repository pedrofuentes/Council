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
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as yaml from "yaml";
import type { ZodError } from "zod";

import { ConfigSchema, type CouncilConfig, type EngineChoice } from "./schema.js";

const CONFIG_FILE = "config.yaml";

type ConfigFieldValue = string | number | boolean | readonly string[];

export interface ConfigFieldUpdate {
  readonly key: string;
  readonly value: ConfigFieldValue;
}

/**
 * Read a filesystem path from an environment variable, normalized for safe use
 * in path construction (config/database/lock files):
 *   - trims surrounding whitespace,
 *   - treats an empty-after-trim value as unset (returns `undefined`),
 *   - resolves the result to an absolute path so relative values don't depend
 *     on the process working directory at each call site.
 * Returns `undefined` when the variable is unset or blank.
 */
function readPathEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return path.resolve(trimmed);
}

/**
 * Resolve the directory that holds Council's runtime data.
 * Honors `COUNCIL_HOME`, then falls back to `COUNCIL_DATA_HOME` so a single
 * env-var override can relocate both runtime and library data together.
 */
export function getCouncilHome(): string {
  const envHome = readPathEnv("COUNCIL_HOME");
  if (envHome !== undefined) return envHome;

  const envDataHome = readPathEnv("COUNCIL_DATA_HOME");
  if (envDataHome !== undefined) return envDataHome;

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
  const envHome = readPathEnv("COUNCIL_DATA_HOME");
  if (envHome !== undefined) return envHome;
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

/**
 * Result of attempting to materialize the default config on disk.
 * `created` is true only for the process that actually created the file via an
 * exclusive create; a process that lost the create race adopts the winner's
 * config and reports `created: false`.
 */
interface WriteDefaultConfigResult {
  readonly config: CouncilConfig;
  readonly created: boolean;
}

/**
 * Materialize the default config using an exclusive create (`wx`) so that when
 * multiple processes start simultaneously on a fresh machine, exactly one wins
 * the create and the others adopt its file rather than clobbering it with a
 * second write (#27). On EEXIST the loser re-reads the winner's config.
 */
async function writeDefaultConfig(): Promise<WriteDefaultConfigResult> {
  const defaults: CouncilConfig = ConfigSchema.parse({});
  const yamlText = yaml.stringify(defaults);
  const banner =
    "# Council configuration\n" +
    "# See https://github.com/pedrofuentes/Council for documentation.\n" +
    "# Edit values below; missing fields use built-in defaults.\n\n";
  const file = configPath();

  let handle: FileHandle;
  try {
    handle = await fs.open(file, "wx");
  } catch (err: unknown) {
    if (hasErrorCode(err, "EEXIST")) {
      // Another process created the config first; adopt its contents.
      return { config: await readExistingConfig(file), created: false };
    }
    throw err;
  }

  try {
    await handle.writeFile(banner + yamlText, "utf-8");
  } finally {
    await handle.close();
  }
  return { config: defaults, created: true };
}

/**
 * Re-read a config that another process created concurrently. The winner may
 * still be flushing its exclusive-create write, so tolerate a brief window of
 * an empty file by retrying before falling back to defaults.
 */
async function readExistingConfig(file: string): Promise<CouncilConfig> {
  const maxAttempts = 20;
  const attemptDelay = 25;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf-8");
    } catch (err: unknown) {
      if (isENOENT(err)) {
        await sleep(attemptDelay);
        continue;
      }
      throw wrapReadError(err, file);
    }
    if (raw.trim().length === 0) {
      // File exists but the winner has not flushed its contents yet.
      await sleep(attemptDelay);
      continue;
    }
    return parseConfig(raw, file);
  }
  // The winner never produced readable content; fall back to defaults.
  return ConfigSchema.parse({});
}

/**
 * Parse raw YAML config text into a validated CouncilConfig. Empty documents
 * resolve to defaults. Throws descriptive errors for malformed YAML or schema
 * validation failures, tagged with the source file.
 */
function parseConfig(raw: string, file: string): CouncilConfig {
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
  return result.data;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Metadata written into the config lock file so other processes can decide
 * whether a lock is stale. `token` uniquely identifies a single acquisition so
 * a holder only ever removes its own lock on release.
 */
interface LockMeta {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly createdAt: number;
}

/**
 * Age after which a lock file is considered abandoned regardless of its owner
 * PID. Generous relative to a config read-modify-write (sub-second) so a slow
 * disk never trips it, while still recovering promptly from a crashed holder
 * on the next `config set`.
 */
const LOCK_STALE_MS = 30_000;

async function withConfigLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const meta = await acquireConfigLock(lockPath);
  try {
    return await fn();
  } finally {
    await releaseConfigLock(lockPath, meta);
  }
}

/**
 * Acquire the config lock, reaping stale locks left by dead or long-gone
 * holders instead of blocking until manual removal (#743). Writes owner
 * PID/host/timestamp into the lock so staleness can be judged by other callers.
 */
async function acquireConfigLock(lockPath: string): Promise<LockMeta> {
  const maxRetries = 50;
  const retryDelay = 100;

  for (let index = 0; index < maxRetries; index += 1) {
    let handle: FileHandle;
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (err: unknown) {
      if (hasErrorCode(err, "EEXIST")) {
        // Lock held by another caller: reap it if the owner is gone, else wait.
        if (await reapIfStale(lockPath)) continue;
        await sleep(retryDelay);
        continue;
      }
      // EPERM / EACCES: transient Windows NTFS contention during concurrent
      // open/close/unlink of the lock file (#820).
      if (hasErrorCode(err, "EPERM") || hasErrorCode(err, "EACCES")) {
        await sleep(retryDelay);
        continue;
      }
      throw err;
    }

    const meta: LockMeta = {
      pid: process.pid,
      host: os.hostname(),
      token: randomUUID(),
      createdAt: Date.now(),
    };
    try {
      await handle.writeFile(JSON.stringify(meta), "utf-8");
    } finally {
      await handle.close();
    }
    return meta;
  }

  throw new Error(`Could not acquire config lock after ${maxRetries} retries`);
}

/**
 * Release the config lock, but only if we still own it. If our lock was reaped
 * as stale and re-acquired by another process, its token won't match and we
 * leave it untouched.
 */
async function releaseConfigLock(lockPath: string, meta: LockMeta): Promise<void> {
  const current = await readLockMeta(lockPath);
  if (current !== undefined && current.token !== meta.token) return;
  await fs.unlink(lockPath).catch(() => undefined);
}

/**
 * Remove a lock that appears abandoned. A lock is stale when its file is older
 * than {@link LOCK_STALE_MS} or when a same-host owner PID is no longer alive.
 * Returns true when the lock was reaped (or already gone) and the caller should
 * retry acquisition immediately.
 */
async function reapIfStale(lockPath: string): Promise<boolean> {
  let mtimeMs: number;
  try {
    const stats = await fs.stat(lockPath);
    mtimeMs = stats.mtimeMs;
  } catch (err: unknown) {
    // Vanished between EEXIST and stat: effectively free, retry immediately.
    return isENOENT(err);
  }

  const ageMs = Date.now() - mtimeMs;
  const meta = await readLockMeta(lockPath);
  const ownerDead = meta !== undefined && meta.host === os.hostname() && !isProcessAlive(meta.pid);

  if (ageMs <= LOCK_STALE_MS && !ownerDead) return false;

  // Reap: ignore ENOENT (another process may have reaped it first).
  await fs.unlink(lockPath).catch(() => undefined);
  return true;
}

/**
 * Read and validate lock metadata. Returns undefined when the lock is missing,
 * empty (not yet flushed), or does not contain well-formed metadata.
 */
async function readLockMeta(lockPath: string): Promise<LockMeta | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf-8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record["pid"] === "number" &&
    typeof record["host"] === "string" &&
    typeof record["token"] === "string" &&
    typeof record["createdAt"] === "number"
  ) {
    return {
      pid: record["pid"],
      host: record["host"],
      token: record["token"],
      createdAt: record["createdAt"],
    };
  }
  return undefined;
}

/**
 * Best-effort liveness probe for a PID on the local host. `process.kill(pid, 0)`
 * sends no signal but validates existence: ESRCH means the process is gone,
 * EPERM means it exists but we can't signal it (still alive).
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return hasErrorCode(err, "EPERM");
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
      const { config, created } = await writeDefaultConfig();
      return { config, isFirstRun: created };
    }
    throw wrapReadError(err, file);
  }

  return { config: parseConfig(raw, file), isFirstRun: false };
}

/**
 * Update a single dot-notation field inside config.yaml, validating the full
 * document before writing any changes back to disk.
 */
export async function updateConfigField(key: string, value: ConfigFieldValue): Promise<void> {
  await updateConfigFields([{ key, value }]);
}

/**
 * Update multiple dot-notation fields inside config.yaml with a single
 * validated atomic write.
 */
export async function updateConfigFields(updates: readonly ConfigFieldUpdate[]): Promise<void> {
  if (updates.length === 0) return;

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
        throw wrapReadError(err, file);
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

    for (const { key, value } of updates) {
      document.setIn(key.split("."), value);
    }

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
 * Run `fn` while holding the same exclusive config write lock used by
 * {@link updateConfigFields}. Callers that perform their own read-modify-write
 * cycle against config.yaml (e.g. `config edit`, which opens an editor and then
 * validates/rolls back) must serialize against `config set`/`config model` so
 * the two paths cannot silently clobber each other's writes (#742). The council
 * home is created first so the lock file has a directory to live in.
 */
export async function withConfigWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureHomeDirectory();
  const lockPath = `${configPath()}.lock`;
  return withConfigLock(lockPath, fn);
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

/**
 * Wrap a non-ENOENT read failure with the offending config path so callers see
 * where the I/O error occurred (EACCES, EISDIR, EMFILE, ...). Non-Error values
 * are normalized; ENOENT is handled separately by writing defaults.
 */
function wrapReadError(err: unknown, file: string): Error {
  if (err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string") {
    const code = (err as NodeJS.ErrnoException).code;
    return new Error(`Failed to read Council config (${file}): ${code} ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
