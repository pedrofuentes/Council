/**
 * Document content extraction and normalization (Roadmap 6.1, hardened
 * for 6.4, refactored for T3).
 *
 * Reads a document file via a TOCTOU-safe file-handle sequence and
 * delegates content normalization to the format-specific extractor
 * registered under the file's extension (or, as a fallback, detected
 * from the buffer's magic bytes). The TOCTOU sequence is unchanged:
 *   1. Open the file handle (`fs.open`) — kernel resolves any symlink
 *      and binds the fd to a specific inode at this instant.
 *   2. Validate via the fd: `fh.stat()` must report a regular file.
 *   3. Enforce `maxFileSizeBytes` against the fd-bound size.
 *   4. Resolve the canonical realpath of the input AFTER opening, then
 *      compare the canonical's inode (`fs.lstat`) to the fd's inode —
 *      a mismatch means an attacker swapped the symlink between open
 *      and realpath; reject.
 *   5. Verify the canonical path is inside `confinementRoot` (also
 *      canonicalized) — rejects symlinks pointing outside and any path
 *      traversal attempts.
 *   6. Read via the file handle (`fh.readFile`), NOT via the path, so
 *      the bytes returned come from the inode bound in step 1.
 *   7. Re-stat through the fd to detect torn reads (size/mtime/ctime
 *      drift, or short reads).
 *   8. Dispatch the buffer to the registry-resolved extractor.
 *   9. Always close the handle in a `finally` block.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  ExtractionError,
  detectFormatByMagicBytes,
  getExtractor,
  getSupportedExtensions,
} from "./extractors/index.js";
import type { ContentExtractor, DocumentMetadata } from "./extractors/index.js";

export interface DocumentContent {
  readonly path: string;
  readonly filename: string;
  readonly content: string;
  readonly wordCount: number;
  readonly checksum: string;
  readonly sizeBytes: number;
  /**
   * ISO-8601 mtime of the file as observed via the bound file handle
   * (`fh.stat`) during extraction. Reading mtime through the fd —
   * instead of via a separate post-open `fs.stat(path)` — closes the
   * TOCTOU window where the recorded mtime could diverge from the
   * content actually read (issue #376).
   */
  readonly modifiedAt: string;
  /**
   * Format-specific metadata surfaced by the underlying extractor
   * (e.g. PDF page count, XLSX sheet names, PPTX slide count). Used by
   * scan-summary UX to show actionable detail per indexed file. The
   * field is optional — extractors that produce no metadata leave it
   * unset; consumers must treat it as best-effort.
   */
  readonly metadata?: DocumentMetadata;
}

export interface ExtractDocumentOptions {
  /**
   * If set, the file's resolved realpath must lie within this directory
   * (which is itself realpath'd before comparison). Symlinks whose
   * targets fall outside are rejected.
   */
  readonly confinementRoot?: string;
  /**
   * When true, `confinementRoot` is treated as already-canonical and
   * the extractor skips its own `fs.realpath()` of the root. Callers
   * that resolve the root ONCE up front pass this to close the
   * root-swap TOCTOU window.
   */
  readonly _rootIsCanonical?: boolean;
  /**
   * Maximum file size in bytes. Files larger than this are rejected
   * with `ExtractionError(oversize-file)` BEFORE any read takes place,
   * preventing memory exhaustion on hostile input. Defaults to 50 MiB
   * (50 * 1024 * 1024). Callers (e.g. processor) pass a configured
   * value derived from `documents.maxFileSizeMB`.
   */
  readonly maxFileSizeBytes?: number;
  /**
   * Test seam — replace `fs.realpath` for the duration of a single
   * call. Used by the unit tests to simulate a post-resolve inode swap
   * without racing the filesystem. Production callers leave this
   * undefined.
   */
  readonly _realpathOverride?: (p: string) => Promise<string>;
  /**
   * Test seam — replace the file-handle read operation. Used to simulate
   * short reads (kernel returns fewer bytes than stat reported) for
   * regression testing of torn-read detection. Production callers leave
   * this undefined.
   */
  readonly _readFileOverride?: (fh: fs.FileHandle) => Promise<Buffer>;
}

const DEFAULT_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel.length === 0) return true;
  if (path.isAbsolute(rel)) return false;
  if (rel === "..") return false;
  if (rel.startsWith(".." + path.sep)) return false;
  return true;
}

async function resolveExtractor(
  ext: string,
  buf: Buffer,
  filePath: string,
): Promise<ContentExtractor> {
  let extractor = await getExtractor(ext).catch(() => null);
  if (extractor === null) {
    const detected = detectFormatByMagicBytes(buf);
    if (detected !== null) {
      extractor = await getExtractor(detected).catch(() => null);
    }
  }
  if (extractor === null) {
    throw new ExtractionError({
      kind: "unsupported-format",
      filePath,
      message: `extractDocument: no extractor registered for '${ext}'`,
      suggestion: `Supported extensions: ${getSupportedExtensions().join(", ")}`,
    });
  }
  return extractor;
}

export async function extractDocument(
  filePath: string,
  options: ExtractDocumentOptions = {},
): Promise<DocumentContent> {
  const realpath = options._realpathOverride ?? fs.realpath;
  const maxBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;

  // 1. Open via fd FIRST. The kernel resolves any symlink at this
  //    instant and binds the handle to a specific inode — once bound,
  //    no subsequent path-based mutation (symlink swap, rename, delete)
  //    can redirect our reads.
  const fh = await fs.open(filePath, "r");
  try {
    const fdStat = await fh.stat();

    // 2. Reject non-regular files (directories, sockets, devices) — we
    //    only ever want plain document content.
    if (!fdStat.isFile()) {
      throw new Error(`extractDocument: ${filePath} is not a regular file`);
    }

    // 3. Size guard BEFORE reading. The fd-bound size cannot be lied
    //    about by a post-open path swap, so this is a coherent ceiling.
    if (fdStat.size > maxBytes) {
      throw new ExtractionError({
        kind: "oversize-file",
        filePath,
        message: `extractDocument: ${filePath} is ${fdStat.size} bytes, exceeds limit ${maxBytes}`,
        suggestion: `Increase documents.maxFileSizeMB or exclude this file.`,
      });
    }

    // 4. Resolve the canonical path now that the fd is bound, then
    //    verify the canonical path's inode matches the fd's inode. If
    //    an attacker swapped a symlink between our open() and this
    //    realpath, the canonical will point at the new target whose
    //    inode differs from what we actually opened — refuse rather
    //    than report attacker-chosen confinement results.
    const canonical = await realpath(filePath);
    const lstat = await fs.lstat(canonical);
    if (lstat.ino !== fdStat.ino || lstat.dev !== fdStat.dev) {
      throw new Error(
        `extractDocument: ${filePath} inode changed between open and realpath (TOCTOU detected)`,
      );
    }

    // 5. Confinement: canonical must lie inside the docs root. Symlinks
    //    pointing outside are rejected here.
    if (options.confinementRoot !== undefined) {
      const rootCanonical =
        options._rootIsCanonical === true
          ? options.confinementRoot
          : await realpath(options.confinementRoot);
      if (!isPathInside(canonical, rootCanonical)) {
        throw new Error(
          `extractDocument: ${filePath} resolves outside confinement root ${options.confinementRoot}`,
        );
      }
    }

    // 6. Read via the file handle (NOT path) so the read targets the
    //    inode bound at step 1, immune to any post-open path swap.
    const readFile = options._readFileOverride ?? ((fh: fs.FileHandle) => fh.readFile());
    const buf = await readFile(fh);
    const checksum = createHash("sha256").update(buf).digest("hex");

    // 7. Re-stat through the same fd AFTER the read so `modifiedAt` is
    //    bound to the bytes we actually returned (issue #376). The
    //    staleness token includes (size, mtimeMs, ctimeMs) — issue #444:
    //    a same-size rewrite whose mtime is restored via utimes() would
    //    evade a (size, mtime) token, but utimes() bumps ctime, so any
    //    mid-read inode metadata write is detectable. We also assert
    //    that the bytes we read fill exactly the size the kernel
    //    reported, which catches truncations or extensions racing the
    //    read itself.
    //
    //    Residual limit: an attacker who can write to the inode AND
    //    forge ctime (raw block-device or kernel-level access — well
    //    outside the docs-folder threat model) could still produce a
    //    same-size, same-mtime, same-ctime rewrite that this guard
    //    cannot detect. Defending against that requires a content
    //    checksum of a re-read pass, which we judge unjustified given
    //    the I/O cost and the privilege required for the attack.
    const postStat = await fh.stat();
    if (
      postStat.size !== fdStat.size ||
      postStat.mtimeMs !== fdStat.mtimeMs ||
      postStat.ctimeMs !== fdStat.ctimeMs ||
      buf.byteLength !== fdStat.size
    ) {
      throw new Error(
        `extractDocument: ${filePath} was modified during read (size/mtime/ctime changed); refusing torn content`,
      );
    }

    // 8. Dispatch to the registered extractor for this format. The
    //    registry decodes the buffer as needed; extractor.ts itself
    //    is format-agnostic and never decodes to a string.
    const ext = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);
    const extractor = await resolveExtractor(ext, buf, filePath);
    const extracted = await extractor({
      buffer: buf,
      filename,
      extension: ext,
      sizeBytes: buf.byteLength,
    });

    return {
      path: filePath,
      filename,
      content: extracted.content,
      wordCount: extracted.wordCount,
      checksum,
      sizeBytes: buf.byteLength,
      // postStat.mtime equals fdStat.mtime here (we just verified) and
      // bounds the moment at which the inode was last written to be
      // ≤ the moment we finished reading — modifiedAt is coherent with
      // `content`/`checksum`.
      modifiedAt: postStat.mtime.toISOString(),
      ...(extracted.metadata !== undefined ? { metadata: extracted.metadata } : {}),
    };
  } finally {
    await fh.close().catch(() => {
      /* best-effort close — primary error already surfaced */
    });
  }
}
