/**
 * Document content extraction and normalization (Roadmap 6.1, hardened
 * for 6.4).
 *
 * Reads a document file, normalizes its text content per format, and
 * returns the plain-text body, word count, SHA-256 checksum of the raw
 * bytes, and size. The normalizer is intentionally simple (regex-based);
 * it strips formatting but does not aim to be a full parser.
 *
 * Security (Roadmap 6.4): the extractor takes an optional
 * `confinementRoot` and, when set, performs a TOCTOU-safe sequence:
 *   1. Open the file handle (`fs.open`) — kernel resolves any symlink
 *      and binds the fd to a specific inode at this instant.
 *   2. Validate via the fd: `fh.stat()` must report a regular file.
 *   3. Resolve the canonical realpath of the input AFTER opening, then
 *      compare the canonical's inode (`fs.lstat`) to the fd's inode —
 *      a mismatch means an attacker swapped the symlink between open
 *      and realpath; reject.
 *   4. Verify the canonical path is inside `confinementRoot` (also
 *      canonicalized) — rejects symlinks pointing outside and any path
 *      traversal attempts.
 *   5. Read via the file handle (`fh.readFile`), NOT via the path, so
 *      the bytes returned come from the inode bound in step 1.
 *   6. Always close the handle in a `finally` block.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

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
   * Test seam — replace `fs.realpath` for the duration of a single
   * call. Used by the unit tests to simulate a post-resolve inode swap
   * without racing the filesystem. Production callers leave this
   * undefined.
   */
  readonly _realpathOverride?: (p: string) => Promise<string>;
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m);
}

function normalizeMarkdown(raw: string): string {
  let s = raw;
  s = s.replace(/```[\s\S]*?```/g, "");
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, "$1$2");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^\s{0,3}[-*+]\s+/gm, "");
  s = s.replace(/^\s{0,3}\d+\.\s+/gm, "");
  return s.trim();
}

function normalizeHtml(raw: string): string {
  let s = raw;
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeHtmlEntities(s);
  s = s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n");
  return s.trim();
}

function countWords(text: string): number {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  return tokens.length;
}

function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel.length === 0) return true;
  if (path.isAbsolute(rel)) return false;
  if (rel === "..") return false;
  if (rel.startsWith(".." + path.sep)) return false;
  return true;
}

export async function extractDocument(
  filePath: string,
  options: ExtractDocumentOptions = {},
): Promise<DocumentContent> {
  const realpath = options._realpathOverride ?? fs.realpath;

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

    // 3. Resolve the canonical path now that the fd is bound, then
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

    // 4. Confinement: canonical must lie inside the docs root. Symlinks
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

    // 5. Read via the file handle (NOT path) so the read targets the
    //    inode bound at step 1, immune to any post-open path swap.
    const buf = await fh.readFile();
    const raw = buf.toString("utf-8");
    const checksum = createHash("sha256").update(buf).digest("hex");
    const ext = path.extname(filePath).toLowerCase();

    // 6. Re-stat through the same fd AFTER the read so `modifiedAt` is
    //    bound to the bytes we actually returned (issue #376). If the
    //    inode's mtime or size changed between the initial stat and now,
    //    the file was modified mid-read — the buffer may be a torn copy
    //    of two versions; refuse rather than persist incoherent state.
    const postStat = await fh.stat();
    if (postStat.size !== fdStat.size || postStat.mtimeMs !== fdStat.mtimeMs) {
      throw new Error(
        `extractDocument: ${filePath} was modified during read (size/mtime changed); refusing torn content`,
      );
    }

    let content: string;
    if (ext === ".md" || ext === ".markdown") content = normalizeMarkdown(raw);
    else if (ext === ".html" || ext === ".htm") content = normalizeHtml(raw);
    else content = raw.trim();

    return {
      path: filePath,
      filename: path.basename(filePath),
      content,
      wordCount: countWords(content),
      checksum,
      sizeBytes: buf.byteLength,
      // postStat.mtime equals fdStat.mtime here (we just verified) and
      // bounds the moment at which the inode was last written to be
      // ≤ the moment we finished reading — modifiedAt is coherent with
      // `content`/`checksum`.
      modifiedAt: postStat.mtime.toISOString(),
    };
  } finally {
    await fh.close().catch(() => {
      /* best-effort close — primary error already surfaced */
    });
  }
}
