/**
 * Shared scan result types (Task T12).
 *
 * Defines the per-file detail shape produced by the panel document
 * scanner and the expert document processor, plus a small helper that
 * classifies arbitrary extractor errors into the user-facing
 * `ScanErrorKind` taxonomy. Living in `core/documents` keeps the
 * dependency direction clean: producers (scanner, processor) and
 * consumers (`src/cli/formatters/scan-summary`) both import from here.
 */

import { ExtractionError } from "./extractors/index.js";
import type { ExtractionErrorKind } from "./extractors/errors.js";

/**
 * Superset of `ExtractionErrorKind` covering failure modes that arise
 * outside the format-specific extractors:
 *   - `extraction-failed` — generic catch-all when the producer cannot
 *     classify the underlying error (e.g. unexpected exceptions from
 *     the indexer).
 *   - `confinement-violation` — the file resolved to a path outside
 *     the panel's docs root (rejected by `extractDocument`'s
 *     confinement guard or by the detector's symlink check).
 */
export type ScanErrorKind =
  | ExtractionErrorKind
  | "extraction-failed"
  | "confinement-violation";

export type ScanFileStatus = "indexed" | "modified" | "unchanged" | "failed";

export interface ScanFileMetadata {
  /** PDF page count (populated by the PDF extractor). */
  readonly pageCount?: number;
  /** Sheet display names (populated by XLSX/ODS extractors). */
  readonly sheetNames?: readonly string[];
  /** Slide count (populated by PPTX/ODP extractors). */
  readonly slideCount?: number;
}

export interface ScanFileDetail {
  readonly path: string;
  readonly filename: string;
  /** Lowercase extension including the leading dot (e.g. ".pdf"). */
  readonly extension: string;
  readonly status: ScanFileStatus;
  /** Classified failure kind. Only populated when `status === "failed"`. */
  readonly errorKind?: ScanErrorKind;
  /** Original error message (used for diagnostics, not the primary display). */
  readonly errorMessage?: string;
  /** Word count from extraction. Triggers zero-word warning when 0. */
  readonly wordCount?: number;
  /** Format-specific extraction metadata (page count, sheet names, slide count). */
  readonly metadata?: ScanFileMetadata;
}

export interface ScanResult {
  readonly indexed: number;
  readonly modified: number;
  readonly unchanged: number;
  readonly failed: number;
  readonly files: readonly ScanFileDetail[];
  /**
   * Configured `documents.maxFileSizeMB`. When provided, the
   * `oversize-file` error message includes the limit so users know
   * what threshold their file exceeded.
   */
  readonly maxFileSizeMB?: number;
}

/**
 * Classify an arbitrary extractor / scanner error into a
 * `ScanErrorKind` plus its raw message. `ExtractionError` instances
 * carry their kind directly. Plain `Error`s thrown by the orchestrator
 * (`extractDocument`) for TOCTOU / confinement rejections are matched
 * by message substring — narrowly, so legitimate failures still
 * surface as `extraction-failed` rather than being miscategorized.
 */
export function classifyExtractionError(err: unknown): {
  readonly kind: ScanErrorKind;
  readonly message: string;
} {
  if (err instanceof ExtractionError) {
    return { kind: err.kind, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes("confinement root") ||
    message.includes("inode changed between open and realpath") ||
    message.includes("resolves outside")
  ) {
    return { kind: "confinement-violation", message };
  }
  return { kind: "extraction-failed", message };
}
