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
  readonly rejectedFiles: readonly string[];
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
   * Test seam — replace `fs.realpath` for the duration of a single
   * call. Production callers leave this undefined.
   */
  readonly _realpathOverride?: (p: string) => Promise<string>;
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
      const rootCanonical = await realpath(options.confinementRoot);
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

  let entries: string[];
  try {
    entries = await fs.readdir(docsPath, { recursive: true });
  } catch (err: unknown) {
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
      };
    }
    throw err;
  }

  const newFiles: DocumentFile[] = [];
  const modifiedFiles: DocumentFile[] = [];
  const unchangedFiles: DocumentFile[] = [];
  const unsupportedFiles: string[] = [];
  const rejectedFiles: string[] = [];

  for (const rel of entries) {
    const absolute = path.resolve(docsPath, rel);
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch {
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
    } catch {
      rejectedFiles.push(absolute);
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

  return { newFiles, modifiedFiles, unchangedFiles, unsupportedFiles, rejectedFiles };
}
