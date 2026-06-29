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
import { attemptAiFallback } from "./extractors/ai-fallback.js";
import type {
  AiFallbackConfig,
  AiFallbackContent,
  AiFallbackLogger,
} from "./extractors/ai-fallback.js";

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

/**
 * AI-fallback configuration accepted by {@link extractDocument}. Extends
 * the fallback's own {@link AiFallbackConfig} (`mode` +
 * `allowedExtensions`) with the optional injected dependencies the
 * extractor forwards verbatim to {@link attemptAiFallback}. Supplying
 * this option with a `mode` other than `"off"` is the ONLY way to make
 * the AI fallback reachable; all of its safety logic (blocklist,
 * magic-byte signature gate, allowlist, audit logging) lives inside
 * `attemptAiFallback` and is never reimplemented here.
 */
export interface AiFallbackOption extends AiFallbackConfig {
  /** Shared cache keyed by buffer SHA-256, forwarded to the fallback. */
  readonly cache?: Map<string, AiFallbackContent>;
  /** Observability logger forwarded to the fallback. */
  readonly logger?: AiFallbackLogger;
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
   * without racing the filesystem. Honored ONLY when NODE_ENV === "test"
   * (#649); ignored in production so it cannot bypass confinement/TOCTOU.
   */
  readonly _realpathOverride?: (p: string) => Promise<string>;
  /**
   * Test seam — replace the file-handle read operation. Used to simulate
   * short reads (kernel returns fewer bytes than stat reported) for
   * regression testing of torn-read detection. Honored ONLY when
   * NODE_ENV === "test" (#649); ignored in production.
   */
  readonly _readFileOverride?: (fh: fs.FileHandle) => Promise<Buffer>;
  /**
   * Opt-in AI fallback for files that no native extractor can handle.
   * When omitted (or `mode === "off"`) an unsupported format throws
   * `ExtractionError(unsupported-format)` exactly as before. When set to
   * `auto` / `ask`, {@link attemptAiFallback} runs ONLY after every
   * TOCTOU / confinement / torn-read guard has passed and ONLY when
   * `resolveExtractor` finds no native extractor (see
   * {@link extractDocument}). The fallback is strictly downstream of the
   * security sequence — it can never weaken or bypass it.
   */
  readonly aiFallback?: AiFallbackOption;
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

/**
 * Build the canonical `unsupported-format` error. Extracted so the
 * native-resolution-failed path and the AI-fallback-declined path raise
 * an identical error (same kind, message, and suggestion).
 */
function unsupportedFormatError(ext: string, filePath: string): ExtractionError {
  return new ExtractionError({
    kind: "unsupported-format",
    filePath,
    message: `extractDocument: no extractor registered for '${ext}'`,
    suggestion: `Supported extensions: ${getSupportedExtensions().join(", ")}`,
  });
}

/**
 * Resolve a native extractor for the file, first by extension and then
 * by magic-byte detection. Returns `null` when neither resolves one — the
 * caller decides whether to attempt the AI fallback or raise
 * `unsupported-format`. (Previously this threw directly; the throw moved
 * up into `extractDocument` so the AI fallback can intercept the failure
 * at the security boundary without changing the no-fallback behavior.)
 */
async function resolveExtractor(ext: string, buf: Buffer): Promise<ContentExtractor | null> {
  let extractor = await tryGetExtractor(ext);
  if (extractor === null) {
    const detected = detectFormatByMagicBytes(buf);
    if (detected !== null) {
      extractor = await tryGetExtractor(detected);
    }
  }
  return extractor;
}

/**
 * Look up an extractor, treating ONLY a registered `unsupported-format`
 * miss as "no extractor" (#932). Every other failure — a loader's dynamic
 * import failing, an extractor init error, a transient dependency fault —
 * is a real error and re-thrown unchanged. Swallowing them as `null` (the
 * old `.catch(() => null)` pattern) masked genuine faults behind a
 * fallthrough to magic-byte probing or a misleading `unsupported-format`.
 */
async function tryGetExtractor(ext: string): Promise<ContentExtractor | null> {
  try {
    return await getExtractor(ext);
  } catch (err) {
    if (err instanceof ExtractionError && err.kind === "unsupported-format") {
      return null;
    }
    throw err;
  }
}

export async function extractDocument(
  filePath: string,
  options: ExtractDocumentOptions = {},
): Promise<DocumentContent> {
  // #649: the `_realpathOverride` / `_readFileOverride` test seams bypass the
  // TOCTOU / confinement / torn-read guarantees. They are honored ONLY under
  // test (NODE_ENV === "test"); a production caller passing them is silently
  // ignored so the security sequence cannot be defeated from outside tests.
  const isTestEnv = process.env.NODE_ENV === "test";
  const realpath = (isTestEnv ? options._realpathOverride : undefined) ?? fs.realpath;
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
    const readFile =
      (isTestEnv ? options._readFileOverride : undefined) ??
      ((fh: fs.FileHandle) => fh.readFile());
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
    // postStat.mtime equals fdStat.mtime here (we just verified) and
    // bounds the moment at which the inode was last written to be
    // ≤ the moment we finished reading — modifiedAt is coherent with
    // `content`/`checksum`. Shared by the native and AI-fallback returns.
    const modifiedAt = postStat.mtime.toISOString();
    const extractor = await resolveExtractor(ext, buf);

    // 8a. Native resolution succeeded → normalize and return as before.
    if (extractor !== null) {
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
        modifiedAt,
        ...(extracted.metadata !== undefined ? { metadata: extracted.metadata } : {}),
      };
    }

    // 8b. No native extractor (neither the extension nor magic-byte
    //     detection resolved one). This is the ONLY place the AI fallback
    //     may run, and ONLY now — strictly downstream of every TOCTOU /
    //     confinement / torn-read guard above (which we never weaken or
    //     relocate). `buf`, `checksum`, and `modifiedAt` are all bound to
    //     the inode we opened in step 1.
    const aiOption = options.aiFallback;
    if (aiOption === undefined || aiOption.mode === "off") {
      // Fallback absent or disabled → preserve the original hard failure.
      throw unsupportedFormatError(ext, filePath);
    }

    // Invoke the fallback. All of its security guard-rails (extension
    // blocklist, magic-byte signature gate, allowedExtensions whitelist,
    // audit logging, never logging raw bytes) live INSIDE this call; we
    // only forward the post-guard buffer plus the injected cache/logger.
    const fallback = await attemptAiFallback(
      { buffer: buf, filename, extension: ext, sizeBytes: buf.byteLength },
      { mode: aiOption.mode, allowedExtensions: aiOption.allowedExtensions },
      {
        ...(aiOption.cache !== undefined ? { cache: aiOption.cache } : {}),
        ...(aiOption.logger !== undefined ? { logger: aiOption.logger } : {}),
      },
    );

    // null ⇒ the fallback's own guards (blocklist / signature gate /
    // allowlist) rejected the file. Surface the hard failure rather than
    // returning empty or attacker-influenced content.
    if (fallback === null) {
      throw unsupportedFormatError(ext, filePath);
    }

    // Build a DocumentContent callers can distinguish from (a) a native
    // extraction (metadata.aiFallback === true) and, in `ask` mode, from
    // (b) ordinary indexable content (metadata.askUser === true marks a
    // review-required result that MUST NOT be indexed without consent).
    const aiMetadata: DocumentMetadata = {
      aiFallback: true,
      detectedFormat: fallback.metadata.detectedFormat,
      suggestedAction: fallback.metadata.suggestedAction,
      ...(fallback.metadata.askUser === true ? { askUser: true } : {}),
    };

    return {
      path: filePath,
      filename,
      content: fallback.content,
      wordCount: fallback.wordCount,
      checksum,
      sizeBytes: buf.byteLength,
      modifiedAt,
      metadata: aiMetadata,
    };
  } finally {
    await fh.close().catch(() => {
      /* best-effort close — primary error already surfaced */
    });
  }
}
