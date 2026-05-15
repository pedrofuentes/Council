/**
 * Document change detection for persona expert docs (Roadmap 6.1,
 * hardened for 6.4).
 *
 * Scans a directory recursively for files matching `supportedFormats`,
 * computes their SHA-256 content checksums, and classifies each file
 * relative to a known checksum map as new, modified, or unchanged.
 * Unsupported formats are reported separately so the caller can warn.
 *
 * Security (Roadmap 6.4): when `confinementRoot` is provided, every file
 * read uses the same TOCTOU-safe sequence as `extractDocument`:
 *   1. Open the file handle (`fs.open`) so the kernel binds the fd to
 *      a specific inode at this instant.
 *   2. Validate via the fd: `fh.stat()` must report a regular file.
 *   3. Resolve the canonical realpath AFTER opening, then compare the
 *      canonical's inode (`fs.lstat`) to the fd's inode — a mismatch
 *      means a symlink was swapped between open and realpath; reject.
 *   4. Verify the canonical path lies inside `confinementRoot` (also
 *      canonicalized). Symlinks pointing outside are rejected.
 *   5. Read via the file handle (`fh.readFile`) so the bytes hashed
 *      come from the inode bound in step 1, never the path.
 *   6. Always close the handle in a `finally` block.
 *
 * Files that fail confinement or TOCTOU validation are reported in
 * `rejectedFiles` and never have their bytes read into the checksum.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";

export interface DocumentFile {
  readonly path: string;
  readonly filename: string;
  readonly checksum: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
}

export interface DetectionResult {
  readonly newFiles: readonly DocumentFile[];
  readonly modifiedFiles: readonly DocumentFile[];
  readonly unchangedFiles: readonly DocumentFile[];
  readonly unsupportedFiles: readonly string[];
  /**
   * Files that failed HARD validation and must not be indexed: confinement
   * boundary violations, post-open inode swaps, TOCTOU rejections from
   * `readConfined`. Callers performing deletion reconciliation are free
   * to treat these as "no longer indexable" — pruning them is the safe
   * choice for a file whose on-disk state is invalid (#342, see
   * `panel-document-scanner.ts`).
   */
  readonly rejectedFiles: readonly string[];
  /**
   * Files whose state could not be determined this scan due to a TRANSIENT
   * I/O failure (lstat threw, readConfined threw with a non-rejection
   * error). The on-disk file likely still exists; callers MUST preserve
   * any prior indexed state across deletion reconciliation rather than
   * pruning, otherwise an EBUSY/EACCES race would silently destroy
   * persisted documents (#342).
   */
  readonly unknownStateFiles: readonly string[];
}

export interface DetectDocumentChangesOptions {
  /**
   * If set, every file's resolved realpath must lie within this
   * directory (which is itself realpath'd before comparison). Symlinks
   * whose targets fall outside, and post-open inode swaps, are
   * rejected without their bytes being read.
   */
  readonly confinementRoot?: string;
  /**
   * When true, `confinementRoot` is treated as already-canonical: the
   * detector skips its own `fs.realpath()` of the root and uses the
   * provided string directly. Callers that resolve the root ONCE at
   * entry (e.g. `DocumentProcessor`) set this to close the root-swap
   * TOCTOU window where re-resolving the root could pick up a fresh
   * symlink installed between entry and per-file confinement checks.
   */
  readonly _rootIsCanonical?: boolean;
  /**
   * Test seam — replace `fs.realpath` for the duration of a single
   * call. Production callers leave this undefined.
   */
  readonly _realpathOverride?: (p: string) => Promise<string>;
  /**
   * Test seam — replace `fs.lstat` for the duration of a single call.
   * Production callers leave this undefined. Used by the per-file
   * resilience tests (#342) to simulate a single file's stat failing
   * mid-scan without modifying the actual filesystem.
   */
  readonly _lstatOverride?: (p: string) => Promise<Stats>;
  /**
   * Test seam (#374) — replace `fs.lstat` for the root-identity
   * verification (pre-readdir + post-readdir) only. Distinct from
   * `_lstatOverride` (which targets per-file stats inside the loop)
   * so tests can simulate a directory swap during the scan window
   * without disturbing per-file stat behaviour. Production callers
   * leave this undefined.
   */
  readonly _rootLstatOverride?: (p: string) => Promise<Stats>;
  /**
   * Test seam (#374) — replace `fs.open` for the directory-fd anchor
   * step only. Lets tests simulate (a) the Windows graceful-fallback
   * path (e.g. throwing `EISDIR`/`EACCES`), (b) an unexpected open
   * failure that MUST be rethrown rather than silently downgraded,
   * and (c) a `FileHandle` whose `.stat()` rejects after a successful
   * open (verifies the handle is still closed). Production callers
   * leave this undefined.
   */
  readonly _rootOpenOverride?: (p: string) => Promise<fs.FileHandle>;
  /**
   * Optional warning sink (#342). Invoked once per individual file
   * skipped due to a recoverable, per-file error (lstat failure,
   * fd-based read failure) so callers can surface diagnostics to the
   * user without aborting the scan. The scan continues regardless of
   * whether the sink is provided.
   */
  readonly onWarning?: (message: string) => void;
}

function normalizeExt(ext: string): string {
  const e = ext.toLowerCase();
  return e.startsWith(".") ? e : `.${e}`;
}

function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel.length === 0) return true;
  if (path.isAbsolute(rel)) return false;
  if (rel === "..") return false;
  if (rel.startsWith(".." + path.sep)) return false;
  return true;
}

/**
 * Read file bytes via fd-bound handle and validate confinement.
 *
 * @returns the read bytes + size + mtime, or `null` if the file was
 *          rejected (TOCTOU mismatch or outside confinement).
 */
async function readConfined(
  absolute: string,
  options: DetectDocumentChangesOptions,
): Promise<{ buf: Buffer; sizeBytes: number; modifiedAt: string } | null> {
  const realpath = options._realpathOverride ?? fs.realpath;

  const fh = await fs.open(absolute, "r");
  try {
    const fdStat = await fh.stat();
    if (!fdStat.isFile()) return null;

    if (options.confinementRoot !== undefined) {
      const canonical = await realpath(absolute);
      const lstat = await fs.lstat(canonical);
      if (lstat.ino !== fdStat.ino || lstat.dev !== fdStat.dev) {
        return null;
      }
      const rootCanonical =
        options._rootIsCanonical === true
          ? options.confinementRoot
          : await realpath(options.confinementRoot);
      if (!isPathInside(canonical, rootCanonical)) {
        return null;
      }
    }

    const buf = await fh.readFile();
    return {
      buf,
      sizeBytes: fdStat.size,
      modifiedAt: fdStat.mtime.toISOString(),
    };
  } finally {
    await fh.close().catch(() => {
      /* best-effort close — primary error already surfaced */
    });
  }
}

export async function detectDocumentChanges(
  docsPath: string,
  knownChecksums: ReadonlyMap<string, string>,
  supportedFormats: readonly string[],
  options: DetectDocumentChangesOptions = {},
): Promise<DetectionResult> {
  const supported = new Set(supportedFormats.map(normalizeExt));
  const rootLstat = options._rootLstatOverride ?? fs.lstat;

  // ── Issue #374: fd-anchored root validation against scan-window TOCTOU.
  // Capture the docs root's identity (dev/ino) BEFORE readdir so we can
  // verify after readdir that the directory we enumerated is the same
  // inode the caller validated. Where the platform supports it (POSIX),
  // we additionally bind a file descriptor to the directory via
  // `fs.open()` and stat through the fd: this anchors the identity
  // check to a kernel handle rather than the path string, closing the
  // window where a swap could land between two path-based lstat calls.
  // Windows generally rejects `fs.open(<dir>)` with EISDIR/EACCES; we
  // treat that as a soft-fail and rely on the pre/post lstat compare,
  // matching the issue requirement to "handle gracefully" on platforms
  // where directory fds aren't supported. Skipped entirely when the
  // caller did not opt into confinement (back-compat).
  let rootIdentity: { dev: number; ino: number } | null = null;
  let rootHandle: fs.FileHandle | null = null;
  if (options.confinementRoot !== undefined) {
    try {
      const pre = await rootLstat(docsPath);
      rootIdentity = { dev: pre.dev, ino: pre.ino };
    } catch {
      // Pre-stat failures fall through — `fs.readdir` below will
      // surface the same condition with the standard error wrapping
      // (#341) and the right ENOENT short-circuit.
    }
    try {
      const open = options._rootOpenOverride ?? fs.open;
      rootHandle = await open(docsPath);
      let fdStat;
      try {
        fdStat = await rootHandle.stat();
      } catch (statErr) {
        // Sentinel #516 finding #2: a stat() failure after a successful
        // open MUST still close the handle, otherwise faulting scans
        // leak directory fds. Re-throw the original error so the caller
        // sees the real cause.
        await rootHandle.close().catch(() => { /* best-effort close */ });
        rootHandle = null;
        throw statErr;
      }
      if (
        rootIdentity !== null &&
        (fdStat.dev !== rootIdentity.dev || fdStat.ino !== rootIdentity.ino)
      ) {
        await rootHandle.close().catch(() => { /* best-effort close */ });
        rootHandle = null;
        throw new Error(
          `document scan: root '${docsPath}' identity changed between lstat and open (TOCTOU)`,
        );
      }
      // Adopt fd-stat as the authoritative identity if pre-lstat was
      // missing — the fd is bound to a specific inode at this instant.
      if (rootIdentity === null) {
        rootIdentity = { dev: fdStat.dev, ino: fdStat.ino };
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      // Re-throw identity-mismatch errors verbatim — they ARE TOCTOU
      // signals, not graceful-fallback conditions.
      if (
        err instanceof Error &&
        err.message.includes("identity changed between lstat and open")
      ) {
        throw err;
      }
      // Windows + some POSIX configurations reject opening a directory
      // for read with one of the codes below; that is graceful
      // degradation, not a TOCTOU signal — fall back to lstat-only.
      const isExpectedDirOpenFailure =
        code === "EISDIR" ||
        code === "EACCES" ||
        code === "EPERM" ||
        code === "ENOTSUP" ||
        code === "EINVAL";
      if (!isExpectedDirOpenFailure) {
        // Sentinel #516 finding #1: operational failures (EMFILE, EIO,
        // synthetic stat failures, etc.) MUST surface to the caller —
        // silently downgrading them would weaken the advertised
        // fd-anchored hardening AND hide a real failure.
        throw err;
      }
      rootHandle = null;
    }
  }

  let entries: string[];
  try {
    entries = await fs.readdir(docsPath, { recursive: true });
  } catch (err: unknown) {
    if (rootHandle !== null) await rootHandle.close().catch(() => { /* best-effort close */ });
    // Only treat truly-missing directories as empty; surface any other
    // filesystem error (permission denied, ENOTDIR, etc.) so callers
    // see a real problem instead of mistaking it for "no documents".
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        newFiles: [],
        modifiedFiles: [],
        unchangedFiles: [],
        unsupportedFiles: [],
        rejectedFiles: [],
        unknownStateFiles: [],
      };
    }
    // Wrap so the failing path + a stable prefix are visible to callers
    // (#341). Keeps the original error as `cause` for diagnostics.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `document scan failed for path '${docsPath}': ${detail}`,
      { cause: err },
    );
  }

  // Post-readdir verification: if the root's inode changed between
  // pre-validation and now, the directory we enumerated is NOT the one
  // the caller validated. Refuse the result — returning entries from a
  // swapped directory would let an attacker redirect the scan into an
  // attacker-chosen tree (issue #374). Best-effort close the fd first.
  if (rootIdentity !== null) {
    try {
      const post = await rootLstat(docsPath);
      if (post.dev !== rootIdentity.dev || post.ino !== rootIdentity.ino) {
        if (rootHandle !== null) await rootHandle.close().catch(() => { /* best-effort close */ });
        throw new Error(
          `document scan: root '${docsPath}' identity changed during scan (TOCTOU)`,
        );
      }
    } catch (err: unknown) {
      // A post-stat failure on a path that just enumerated successfully
      // is suspicious. Re-throw identity-change errors verbatim;
      // otherwise wrap so callers see WHY post-validation failed.
      if (rootHandle !== null) await rootHandle.close().catch(() => { /* best-effort close */ });
      if (err instanceof Error && err.message.includes("identity changed during scan")) {
        throw err;
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `document scan: post-scan root validation failed for '${docsPath}': ${detail}`,
        { cause: err },
      );
    }
  }
  if (rootHandle !== null) await rootHandle.close().catch(() => { /* best-effort close */ });

  const lstat = options._lstatOverride ?? fs.lstat;

  const newFiles: DocumentFile[] = [];
  const modifiedFiles: DocumentFile[] = [];
  const unchangedFiles: DocumentFile[] = [];
  const unsupportedFiles: string[] = [];
  const rejectedFiles: string[] = [];
  const unknownStateFiles: string[] = [];

  for (const rel of entries) {
    const absolute = path.resolve(docsPath, rel);
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (err: unknown) {
      // A single file disappearing (or otherwise being unstatable)
      // between readdir and lstat must not abort the whole scan
      // (#342). Push to `unknownStateFiles` (NOT `rejectedFiles`) so
      // callers performing deletion reconciliation
      // (`DocumentProcessor.process()`, `panel-document-scanner`) can
      // treat a transient stat failure as "still present" and preserve
      // tracked state. Hard rejections (`rejectedFiles`) keep their
      // existing semantics so callers like the panel scanner remain
      // free to prune confinement-violating paths. Surface a warning
      // so users can see WHICH file was skipped and WHY.
      if (options.onWarning) {
        const detail = err instanceof Error ? err.message : String(err);
        options.onWarning(
          `document scan: skipping '${absolute}' (lstat failed: ${detail})`,
        );
      }
      unknownStateFiles.push(absolute);
      continue;
    }
    // Recurse-marker entries from readdir include directories themselves;
    // skip those without touching the fd path. Symlinks fall through to
    // the fd-based read which will validate the target.
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;

    const ext = path.extname(absolute).toLowerCase();
    if (!supported.has(ext)) {
      unsupportedFiles.push(absolute);
      continue;
    }

    let read;
    try {
      read = await readConfined(absolute, options);
    } catch (err: unknown) {
      // readConfined throwing (vs returning null) is a transient I/O
      // failure — open(2)/read(2)/realpath errors that aren't
      // confinement violations. Treat as unknown-state so reconciliation
      // does not prune. Hard rejections (TOCTOU, confinement) come back
      // as `read === null` below and remain in `rejectedFiles`.
      if (options.onWarning) {
        const detail = err instanceof Error ? err.message : String(err);
        options.onWarning(
          `document scan: rejecting '${absolute}' (read failed: ${detail})`,
        );
      }
      unknownStateFiles.push(absolute);
      continue;
    }
    if (read === null) {
      rejectedFiles.push(absolute);
      continue;
    }

    const checksum = createHash("sha256").update(read.buf).digest("hex");
    const file: DocumentFile = {
      path: absolute,
      filename: path.basename(absolute),
      checksum,
      sizeBytes: read.sizeBytes,
      modifiedAt: read.modifiedAt,
    };

    const known = knownChecksums.get(absolute);
    if (known === undefined) newFiles.push(file);
    else if (known === checksum) unchangedFiles.push(file);
    else modifiedFiles.push(file);
  }

  return { newFiles, modifiedFiles, unchangedFiles, unsupportedFiles, rejectedFiles, unknownStateFiles };
}
