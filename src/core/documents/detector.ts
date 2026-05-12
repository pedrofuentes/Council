/**
 * Document change detection for persona expert docs (Roadmap 6.1).
 *
 * Scans a directory recursively for files matching `supportedFormats`,
 * computes their SHA-256 content checksums, and classifies each file
 * relative to a known checksum map as new, modified, or unchanged.
 * Unsupported formats are reported separately so the caller can warn.
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
}

function normalizeExt(ext: string): string {
  const e = ext.toLowerCase();
  return e.startsWith(".") ? e : `.${e}`;
}

export async function detectDocumentChanges(
  docsPath: string,
  knownChecksums: ReadonlyMap<string, string>,
  supportedFormats: readonly string[],
): Promise<DetectionResult> {
  const supported = new Set(supportedFormats.map(normalizeExt));

  let entries: string[];
  try {
    entries = await fs.readdir(docsPath, { recursive: true });
  } catch {
    return { newFiles: [], modifiedFiles: [], unchangedFiles: [], unsupportedFiles: [] };
  }

  const newFiles: DocumentFile[] = [];
  const modifiedFiles: DocumentFile[] = [];
  const unchangedFiles: DocumentFile[] = [];
  const unsupportedFiles: string[] = [];

  for (const rel of entries) {
    const absolute = path.resolve(docsPath, rel);
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const ext = path.extname(absolute).toLowerCase();
    if (!supported.has(ext)) {
      unsupportedFiles.push(absolute);
      continue;
    }

    const buf = await fs.readFile(absolute);
    const checksum = createHash("sha256").update(buf).digest("hex");
    const file: DocumentFile = {
      path: absolute,
      filename: path.basename(absolute),
      checksum,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };

    const known = knownChecksums.get(absolute);
    if (known === undefined) newFiles.push(file);
    else if (known === checksum) unchangedFiles.push(file);
    else modifiedFiles.push(file);
  }

  return { newFiles, modifiedFiles, unchangedFiles, unsupportedFiles };
}
