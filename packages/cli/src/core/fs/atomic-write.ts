/**
 * Symlink/TOCTOU-safe atomic file write (CWE-59 hardening, #2206).
 *
 * Shared helper for Council-written cache/state files that a concurrent reader
 * must never observe half-written. It mirrors the config loader's
 * {@link ../../config/loader.writeConfigAtomically} (#1925) so the update
 * notifier and telemetry writers stop using a PREDICTABLE temp name
 * (`<path>.<pid>.tmp`) plus a symlink-following `writeFile`.
 *
 * Hardening properties:
 *   - The temp file name embeds cryptographically-random bytes, so an attacker
 *     on a shared directory cannot guess or pre-create the path the writer is
 *     about to use.
 *   - The temp file is opened with `"wx"` (O_CREAT|O_EXCL|O_WRONLY): a
 *     pre-existing entry at the temp path — including a symlink planted to
 *     redirect the write onto a victim file — fails with EEXIST instead of
 *     being followed.
 *   - Content is written THROUGH that exclusive handle (the path is never
 *     re-opened), eliminating the write-time TOCTOU window, then renamed over
 *     the destination.
 *   - EEXIST triggers a bounded retry with a fresh random name rather than
 *     following or overwriting the existing entry, and a failed rename unlinks
 *     the temp file so a botched write never leaves it behind.
 *
 * The loader keeps its own copy of this logic for now (to avoid conflicts with
 * pending config-lock work); it can adopt this helper in a later change.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Number of cryptographically-random bytes mixed into the temp file name.
 * 12 bytes (96 bits) makes the path infeasible to guess or pre-create.
 */
const TEMP_RANDOM_BYTES = 12;

/**
 * Maximum number of exclusive-create attempts. A random-name collision is
 * astronomically unlikely, but a pre-planted file/symlink also surfaces as
 * EEXIST — retrying with a fresh name lets a legitimate write succeed without
 * ever following or clobbering the existing entry.
 */
const TEMP_MAX_ATTEMPTS = 10;

export interface AtomicWriteOptions {
  /**
   * File mode for the exclusively-created temp file. The final file inherits it
   * via `rename`. Omit to use the platform default (`0o666` minus umask).
   */
  readonly mode?: number;
  /** Text encoding used when `data` is a string. Defaults to `"utf-8"`. */
  readonly encoding?: BufferEncoding;
  /**
   * Create the destination's parent directory (recursively) before writing.
   * Defaults to `true`, matching the callers that previously did their own
   * `mkdir`.
   */
  readonly ensureParentDir?: boolean;
}

/**
 * Atomically write `data` to `filePath` via a randomized, exclusively-created
 * temp file in the same directory, then rename it over `filePath`. See the
 * module header for the symlink/TOCTOU hardening guarantees.
 *
 * @throws if a non-EEXIST error occurs opening the temp file, if the write or
 * rename fails, or if every one of {@link TEMP_MAX_ATTEMPTS} exclusive-create
 * attempts collides with a pre-existing entry.
 */
export async function writeFileAtomicSafe(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const encoding = options.encoding ?? "utf-8";
  const ensureParentDir = options.ensureParentDir ?? true;

  if (ensureParentDir) {
    await mkdir(dirname(filePath), { recursive: true });
  }

  let lastOpenError: unknown;
  for (let attempt = 0; attempt < TEMP_MAX_ATTEMPTS; attempt += 1) {
    const tempPath = `${filePath}.${randomBytes(TEMP_RANDOM_BYTES).toString("hex")}.tmp`;

    let handle: FileHandle;
    try {
      handle = await open(tempPath, "wx", options.mode);
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
      await handle.writeFile(data, encoding);
    } finally {
      await handle.close();
    }

    try {
      await rename(tempPath, filePath);
    } catch (renameErr) {
      await unlink(tempPath).catch(() => undefined);
      throw renameErr;
    }
    return;
  }

  throw new Error(
    `Could not create an exclusive temporary file for ${filePath} after ${TEMP_MAX_ATTEMPTS} attempts`,
    { cause: lastOpenError },
  );
}

function hasErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}
