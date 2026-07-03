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
import { randomBytes, randomUUID } from "node:crypto";
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
 * whether a lock is stale. `token` uniquely identifies a single acquisition.
 * The on-disk metadata is consumed by the cross-process staleness reaper
 * ({@link reapIfStale}); a holder proves ownership on RELEASE structurally, via
 * the file's inode identity (see {@link LockOwnership}), not by reading `token`.
 */
interface LockMeta {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly createdAt: number;
}

/**
 * Structural identity of a lock file: the ({@link https://man7.org/linux/man-pages/man7/inode.7.html dev},
 * ino) pair uniquely names the physical file on disk. Because the lock protocol
 * only ever creates a lock via an exclusive `wx` open on a FREE path, a
 * successor cannot overwrite a live lock in place — it must remove the old file
 * and create its own, which necessarily yields a DIFFERENT inode. So a matching
 * identity PROVES the file at the path is still the exact one we created, and
 * any change reveals a reap+recreate hand-off we must not delete (#1923/#2118).
 *
 * PRECONDITION — ownership proof requires a stable, NON-ZERO `st_ino`. On some
 * NFS/SMB/CIFS/FUSE/overlay mounts libuv reports `st_ino = 0` (or unstable/reused
 * values) and cannot uniquely name a file; the #2118 shared-FS multi-host target
 * is exactly such an environment. Both fields are captured/compared as `bigint`
 * (`{ bigint: true }` stat) so 64-bit ids never lose precision past 2^53, and an
 * `ino` of `0n` is treated as UNPROVABLE (see {@link isProvableIdentity}): we
 * never unlink or reap on structural identity alone in that case.
 */
interface LockIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * Whether a captured {@link LockIdentity} can positively prove file ownership.
 * An `ino` of `0n` means the filesystem did not supply a usable inode number
 * (non-authoritative `st_ino`), so a structural match cannot be trusted and the
 * caller must fail safe — never unlink or reap on identity alone.
 */
function isProvableIdentity(identity: LockIdentity): boolean {
  return identity.ino !== 0n;
}

/**
 * What a caller holds after acquiring the lock. The still-open {@link handle}
 * pins the descriptor for the lifetime of the critical section and lets release
 * (a) prove the on-disk file is byte-for-byte the one it created via
 * {@link identity}, and (b) close exactly the fd it opened. {@link meta} is the
 * metadata persisted for the reaper's benefit.
 */
interface LockOwnership {
  readonly meta: LockMeta;
  readonly handle: FileHandle;
  readonly identity: LockIdentity;
}

/**
 * The evidence the reaper recorded when it DECIDED a lock was stale, carried
 * through the atomic rename-to-claim so the removal step can re-verify it is
 * acting on the very same lock. When {@link meta} is defined the claimed file is
 * matched by its logical identity (token + createdAt); when the deciding
 * metadata was unreadable, it is matched structurally by {@link identity}.
 */
interface LockDecision {
  readonly meta: LockMeta | undefined;
  readonly identity: LockIdentity;
}

/**
 * Age after which a lock file with no identifiable live owner is considered
 * abandoned. Only consulted when the owner cannot be probed for liveness
 * (missing/unreadable metadata, or an owner on another host); a lock owned by a
 * live same-host process is never reaped by age (#742). Generous relative to a
 * config read-modify-write (sub-second) so a slow disk never trips it, while
 * still recovering promptly from an unidentifiable crashed holder.
 */
const LOCK_STALE_MS = 30_000;

async function withConfigLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const ownership = await acquireConfigLock(lockPath);
  try {
    return await fn();
  } finally {
    await releaseConfigLock(lockPath, ownership);
  }
}

/**
 * Acquire the config lock, reaping stale locks left by dead or long-gone
 * holders instead of blocking until manual removal (#743). Writes owner
 * PID/host/timestamp into the lock so staleness can be judged by other callers.
 *
 * The exclusive open handle is HELD (not closed) and returned to the caller so
 * release can later prove the on-disk file is still the exact one created here,
 * by its inode identity ({@link LockIdentity}). This is what lets release refuse
 * to delete a foreign successor's lock that reaped+recreated the path (#1923),
 * or a file it cannot positively identify after a transient stat fault (#2118).
 */
async function acquireConfigLock(lockPath: string): Promise<LockOwnership> {
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
      // Capture the created file's inode identity from the SAME open handle
      // (authoritative fstat on the fd we hold), so release can later confirm the
      // file still at `lockPath` is byte-for-byte the one we created. Captured as
      // bigint ({ bigint: true }) so 64-bit dev/ino compare exactly; a filesystem
      // that reports ino=0 yields an UNPROVABLE identity (see isProvableIdentity).
      // The handle is intentionally kept OPEN and returned; release closes it.
      const stats = await handle.stat({ bigint: true });
      return { meta, handle, identity: { dev: stats.dev, ino: stats.ino } };
    } catch (err: unknown) {
      // The exclusive open already created the lock file. If writing the owner
      // metadata or capturing its identity failed (ENOSPC/EIO), remove the
      // just-created file before propagating: an orphan lock with no owner
      // metadata can never be re-created with `wx` and would wedge every future
      // acquisition until the staleness window elapses (#1924).
      await handle.close().catch(() => undefined);
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  throw new Error(`Could not acquire config lock after ${maxRetries} retries`);
}

/**
 * Release the config lock, but only if the file still at `lockPath` is provably
 * the exact one we created — proven structurally by its inode identity, never by
 * reading the on-disk token. We `lstat` the path (no-follow) and compare its
 * ({@link LockIdentity dev, ino}) to the identity captured at acquire:
 *
 *   - identity matches (and is provable) → still OUR file → unlink it (#2102: a
 *     live same-host owner's lock is never age-reaped, so stranding our own lock
 *     would wedge every future writer indefinitely; releasing it in the common
 *     case avoids that). ENOENT on the unlink is ignored (a reaper may have raced
 *     us).
 *   - identity differs → a successor reaped our lock and re-created a DIFFERENT
 *     file at the path (A-B-A); we must NOT unlink it (#1923).
 *   - identity UNPROVABLE (`ino === 0n`: non-authoritative `st_ino` on some
 *     NFS/SMB/FUSE mounts, the #2118 shared-FS target) → we cannot prove the file
 *     is ours, so we must NOT unlink it; the bounded residual strand is recovered
 *     later by the reaper — strictly safer than deleting a foreign successor.
 *   - stat fails, ENOENT → already gone, nothing to release.
 *   - stat fails, TRANSIENT (EIO/EACCES/EBUSY/EMFILE…) → we CANNOT prove the
 *     file is ours, so we must NOT unlink it. Deleting a file we cannot identify
 *     risks destroying a foreign successor's lock (#2118); the bounded residual
 *     strand of our own lock is instead recovered later by the reaper — strictly
 *     safer than a blind unlink.
 *
 * The held descriptor is ALWAYS closed. The on-disk token/meta are left intact
 * for the reaper; identity, not the token, governs deletion here.
 */
async function releaseConfigLock(lockPath: string, ownership: LockOwnership): Promise<void> {
  const { handle, identity } = ownership;
  try {
    const stats = await fs.lstat(lockPath, { bigint: true });
    // Fail safe: only unlink when the on-disk file is PROVABLY the one we created
    // — a non-zero inode captured at acquire that still matches here. A filesystem
    // reporting ino=0 (non-authoritative st_ino) cannot prove ownership, so we
    // leave the file for the reaper rather than risk deleting a foreign successor.
    if (
      isProvableIdentity(identity) &&
      stats.ino !== 0n &&
      stats.dev === identity.dev &&
      stats.ino === identity.ino
    ) {
      await fs.unlink(lockPath).catch(() => undefined);
    }
  } catch {
    // ENOENT (already gone) or a transient stat error (cannot prove identity):
    // either way, never unlink a file we cannot positively identify as ours.
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Remove a lock that appears abandoned. A lock owned by a LIVE process on this
 * host is never stale, regardless of age: a long-running interactive
 * `config edit` legitimately holds the write lock for minutes, and reaping it
 * would let a concurrent writer clobber its pending write (silent config data
 * loss, #742). Reaping therefore applies only when the owner is provably gone
 * or cannot be identified:
 *   - a same-host owner whose PID is no longer alive (crash recovery, #743) is
 *     reaped immediately, regardless of age;
 *   - a lock with missing/unreadable metadata, or an owner on another host
 *     whose liveness we cannot probe, is reaped only once its file has aged past
 *     {@link LOCK_STALE_MS}, so a crashed or foreign holder can't wedge it
 *     forever.
 * The decision here is unchanged; the actual removal is delegated to
 * {@link claimAndReap}, which removes the deciding lock ATOMICALLY (rename-to-
 * claim + re-verify) so a successor that replaced the lock between this decision
 * and the removal is never destroyed (#1923 reaper A-B-A).
 * Returns true when the lock was reaped (or already gone) and the caller should
 * retry acquisition immediately; false when it must keep waiting.
 */
async function reapIfStale(lockPath: string): Promise<boolean> {
  let identity: LockIdentity;
  let mtimeMs: number;
  try {
    const stats = await fs.stat(lockPath, { bigint: true });
    mtimeMs = Number(stats.mtimeMs);
    identity = { dev: stats.dev, ino: stats.ino };
  } catch (err: unknown) {
    // Vanished between EEXIST and stat: effectively free, retry immediately.
    return isENOENT(err);
  }

  const meta = await readLockMeta(lockPath);

  // Owner recorded on this host: trust liveness over age. A live owner holds the
  // lock indefinitely (#742); a dead owner is reaped at once (crash recovery).
  if (meta !== undefined && meta.host === os.hostname()) {
    if (isProcessAlive(meta.pid)) return false;
    return claimAndReap(lockPath, { meta, identity });
  }

  // Owner unidentifiable (missing/unreadable metadata) or on another host
  // (liveness unprobeable): fall back to age so a crashed or foreign holder
  // can't wedge the lock forever, while a recent lock is still respected.
  const ageMs = Date.now() - mtimeMs;
  if (ageMs <= LOCK_STALE_MS) return false;

  return claimAndReap(lockPath, { meta, identity });
}

/**
 * Remove the SPECIFIC lock file the reaper decided is stale, atomically, closing
 * the decision→removal A-B-A window (#1923). Between deciding a lock is stale and
 * unlinking it, a successor can reap that lock and re-acquire the same path; a
 * blind `unlink(lockPath)` would then destroy the successor's live lock.
 *
 * Instead we CLAIM the file by renaming it aside to a unique name (rename is
 * atomic on POSIX and Windows), which detaches exactly the bytes currently at the
 * path from any future `wx` acquirer, then RE-VERIFY the claimed file is the one
 * we decided on before deleting it:
 *   - rename throws ENOENT → someone else already reaped it / it vanished → the
 *     path is free, so report success and let the caller retry acquisition;
 *   - rename throws otherwise (transient EPERM/EACCES contention) → we claimed
 *     nothing → leave the lock in place and let the caller retry/wait;
 *   - claimed file matches the decision → unlink it (reap succeeds);
 *   - claimed file does NOT match (a successor swapped in between decision and
 *     claim) → rename it BACK to the lock path and abort the reap (#1923).
 *
 * A concurrent `wx` acquire that runs after our rename creates a NEW, distinct
 * file at the freed path that we never touch. (Residual, accepted micro-window:
 * if a fresh acquirer wins the path in the sub-instant between our rename-away
 * and a mismatch rename-BACK, POSIX rename replaces it; this is far rarer than —
 * and strictly no worse than — the previous unconditional blind unlink.)
 */
async function claimAndReap(lockPath: string, deciding: LockDecision): Promise<boolean> {
  const claimedPath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await fs.rename(lockPath, claimedPath);
  } catch (err: unknown) {
    // Already reaped by someone else, or vanished: the path is free, retry.
    if (isENOENT(err)) return true;
    // Transient rename failure: we did not claim anything, so leave the lock.
    return false;
  }

  // We now exclusively hold the claimed file. Confirm it is the lock we decided
  // to reap before deleting it.
  if (await claimedFileMatchesDecision(claimedPath, deciding)) {
    await fs.unlink(claimedPath).catch(() => undefined);
    return true;
  }

  // A successor swapped in a different lock between our decision and our claim:
  // put the claimed file back and abort — never delete a lock we did not decide
  // on (#1923). If renaming back fails (e.g. a fresh acquirer already created a
  // lock at the path on Windows, where rename-onto-existing errors), discard the
  // claimed copy so it does not linger as an orphan.
  try {
    await fs.rename(claimedPath, lockPath);
  } catch {
    await fs.rm(claimedPath, { force: true }).catch(() => undefined);
  }
  return false;
}

/**
 * Confirm a claimed (renamed-aside) lock file is the same one the reaper decided
 * to reap. When the deciding metadata was readable, match by its logical
 * identity (token + createdAt) — a successor that reaped and re-created the lock
 * carries a different token even if it reused the path. When the deciding
 * metadata was unreadable, fall back to the structural inode identity captured
 * at decision time (rename preserves a file's inode, so a match proves no
 * successor swapped in).
 */
async function claimedFileMatchesDecision(
  claimedPath: string,
  deciding: LockDecision,
): Promise<boolean> {
  if (deciding.meta !== undefined) {
    const claimedMeta = await readLockMeta(claimedPath);
    return (
      claimedMeta !== undefined &&
      claimedMeta.token === deciding.meta.token &&
      claimedMeta.createdAt === deciding.meta.createdAt
    );
  }
  try {
    const stats = await fs.stat(claimedPath, { bigint: true });
    // Fail safe: a matching inode only proves "no successor swapped in" when the
    // filesystem supplies a stable, non-zero st_ino. If ino=0 (non-authoritative
    // st_ino on some NFS/SMB/FUSE mounts), the structural match is untrustworthy —
    // return false so we do NOT reap a file we cannot positively identify.
    return (
      isProvableIdentity(deciding.identity) &&
      stats.ino !== 0n &&
      stats.dev === deciding.identity.dev &&
      stats.ino === deciding.identity.ino
    );
  } catch {
    return false;
  }
}

/**
 * Read and validate lock metadata. Returns undefined when the lock is missing,
 * unreadable, empty (not yet flushed), or does not contain well-formed metadata.
 */
async function readLockMeta(lockPath: string): Promise<LockMeta | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf-8");
  } catch {
    return undefined;
  }
  return parseLockMeta(raw);
}

/**
 * Parse validated lock metadata from raw lock-file contents. Returns undefined
 * when the content is empty (not yet flushed) or is not well-formed metadata.
 * Split out from {@link readLockMeta} so the reaper can match a claimed file's
 * logical owner (token + createdAt) when re-verifying a decision (#1923).
 */
function parseLockMeta(raw: string): LockMeta | undefined {
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

    await writeConfigAtomically(file, document.toString());
  });
}

/**
 * Number of cryptographically-random bytes mixed into the atomic-write temp file
 * name. 12 bytes (96 bits of entropy) makes the path infeasible to guess or
 * pre-create, so an attacker on a shared temp directory cannot plant an entry at
 * the path the writer is about to use (#1925).
 */
const CONFIG_TEMP_RANDOM_BYTES = 12;

/**
 * Maximum number of exclusive-create attempts for the atomic-write temp file.
 * A name collision is astronomically unlikely for random names, but a
 * pre-planted file/symlink at the chosen path also surfaces as EEXIST — retrying
 * with a fresh name lets a legitimate write succeed without ever following or
 * clobbering the existing entry.
 */
const CONFIG_TEMP_MAX_ATTEMPTS = 10;

/**
 * Atomically write `contents` to `file` via a randomized, exclusively-created
 * temp file in the same directory, then rename it over `file`.
 *
 * Symlink/TOCTOU hardening (#1925): the temp file name embeds cryptographically
 * random bytes so it cannot be guessed or pre-created, and it is opened with
 * `"wx"` (O_CREAT|O_EXCL|O_WRONLY) so a pre-existing entry at the temp path —
 * including a symlink an attacker planted to redirect the write onto a victim
 * file — fails with EEXIST instead of being followed. Content is written THROUGH
 * that exclusive handle (the path is never re-opened), eliminating the write-time
 * TOCTOU window. On EEXIST we retry with a fresh random name rather than
 * following or overwriting the existing entry. The rename-failure path still
 * unlinks the temp file so a failed write never leaves the temp behind as config.
 */
async function writeConfigAtomically(file: string, contents: string): Promise<void> {
  let lastOpenError: unknown;
  for (let attempt = 0; attempt < CONFIG_TEMP_MAX_ATTEMPTS; attempt += 1) {
    const tmpFile = `${file}.${randomBytes(CONFIG_TEMP_RANDOM_BYTES).toString("hex")}.tmp`;

    let handle: FileHandle;
    try {
      handle = await fs.open(tmpFile, "wx");
    } catch (err: unknown) {
      if (hasErrorCode(err, "EEXIST")) {
        // The unguessable temp path already exists: an astronomically unlikely
        // random collision, or a file/symlink an attacker pre-planted there.
        // Never follow or overwrite it — retry with a fresh random name.
        lastOpenError = err;
        continue;
      }
      throw err;
    }

    try {
      await handle.writeFile(contents, "utf-8");
    } finally {
      await handle.close();
    }

    try {
      await fs.rename(tmpFile, file);
    } catch (renameErr) {
      await fs.unlink(tmpFile).catch(() => undefined);
      throw renameErr;
    }
    return;
  }

  throw new Error(
    `Could not create an exclusive temporary file for ${file} after ${CONFIG_TEMP_MAX_ATTEMPTS} attempts`,
    { cause: lastOpenError },
  );
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
