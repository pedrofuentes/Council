/**
 * Scan summary formatter (Task T12).
 *
 * Translates a `ScanResult` — the structured per-file output of the
 * panel document scanner and the expert document processor — into a
 * compact, human-readable multi-line string suitable for display at
 * panel/chat startup or in CLI output.
 *
 * Design goals:
 *   - Show actionable detail for new/modified/failed files only.
 *     Unchanged files collapse into a single summary line so a
 *     well-cached corpus does not flood the terminal.
 *   - Translate the typed `ExtractionErrorKind` taxonomy into
 *     user-facing messages (Format not supported, Password-protected,
 *     etc.) — operators should not need to read raw error strings to
 *     diagnose a failure.
 *   - Surface format-specific extraction metadata when available
 *     (PDF page count, XLSX/ODS sheet names, PPTX/ODP slide count).
 *   - Warn when extraction succeeded but produced zero words — these
 *     are silent failures that would otherwise go unnoticed.
 *
 * The formatter is a pure function with no side effects; producers
 * (panel-document-scanner, processor) construct a `ScanResult` from
 * their per-file outcomes and pass it through this single rendering
 * boundary.
 */

import type {
  ScanErrorKind,
  ScanFileDetail,
  ScanFileMetadata,
  ScanResult,
} from "../../core/documents/scan-types.js";

export type {
  ScanErrorKind,
  ScanFileDetail,
  ScanFileMetadata,
  ScanFileStatus,
  ScanResult,
} from "../../core/documents/scan-types.js";
export { classifyExtractionError } from "../../core/documents/scan-types.js";

const ERROR_MESSAGES: Readonly<Record<ScanErrorKind, string>> = {
  "unsupported-format": "Format not supported",
  "oversize-file": "File too large",
  "corrupt-document": "File appears corrupted",
  "encrypted-document": "Password-protected file",
  "zip-bomb-detected": "Suspicious archive structure",
  "extraction-failed": "Extraction failed",
  "confinement-violation": "File outside allowed directory",
  "extraction-timeout": "Extraction timed out",
  "ai-extraction-declined": "AI extraction declined",
  "ai-extraction-failed": "AI extraction failed",
};

export interface DescribeScanErrorOptions {
  readonly maxFileSizeMB?: number;
}

export function describeScanError(
  kind: ScanErrorKind,
  options: DescribeScanErrorOptions = {},
): string {
  if (kind === "oversize-file" && options.maxFileSizeMB !== undefined) {
    return `File too large (limit: ${options.maxFileSizeMB} MB)`;
  }
  return ERROR_MESSAGES[kind];
}

function pluralize(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? `${singular}s`);
}

function formatMetadata(meta: ScanFileMetadata | undefined): string | null {
  if (meta === undefined) return null;
  const parts: string[] = [];
  if (meta.pageCount !== undefined) {
    parts.push(`${meta.pageCount} ${pluralize(meta.pageCount, "page")}`);
  }
  if (meta.slideCount !== undefined) {
    parts.push(`${meta.slideCount} ${pluralize(meta.slideCount, "slide")}`);
  }
  if (meta.sheetNames !== undefined && meta.sheetNames.length > 0) {
    parts.push(`sheets: ${meta.sheetNames.join(", ")}`);
  }
  return parts.length === 0 ? null : parts.join(", ");
}

function formatSuccessLine(file: ScanFileDetail): string {
  const verb = file.status === "modified" ? "Updated" : "Indexed";
  const meta = formatMetadata(file.metadata);
  let line = `✓ ${verb} ${file.filename}`;
  if (meta !== null) line += ` (${meta})`;
  if (file.wordCount === 0) {
    line += " — ⚠ Extracted but no text content found";
  }
  return line;
}

function formatFailureLine(
  file: ScanFileDetail,
  maxFileSizeMB: number | undefined,
): string {
  const kind = file.errorKind ?? "extraction-failed";
  const human = describeScanError(
    kind,
    maxFileSizeMB !== undefined ? { maxFileSizeMB } : {},
  );
  return `✗ ${file.filename}: ${human}`;
}

export function formatScanSummary(result: ScanResult): string {
  const totalActivity =
    result.indexed + result.modified + result.unchanged + result.failed;
  if (totalActivity === 0 && result.files.length === 0) {
    return "No documents found.";
  }

  const lines: string[] = [];

  if (result.unchanged > 0) {
    lines.push(`${result.unchanged} ${pluralize(result.unchanged, "file")} unchanged`);
  }

  for (const file of result.files) {
    if (file.status === "unchanged") continue;
    if (file.status === "indexed" || file.status === "modified") {
      lines.push(formatSuccessLine(file));
    } else if (file.status === "failed") {
      lines.push(formatFailureLine(file, result.maxFileSizeMB));
    }
  }

  return lines.join("\n");
}

/**
 * Render a scan summary to a renderer, emitting one showSystem call per
 * non-empty line. This avoids the sanitizeSingleLine newline collapse
 * that occurs when a multi-line string is passed as a single message.
 */
export function renderScanLines(
  renderer: { showSystem(message: string, level: "info" | "warn" | "error"): void },
  result: ScanResult,
): void {
  const summary = formatScanSummary(result);
  if (summary.length === 0 || summary === "No documents found.") return;
  for (const line of summary.split("\n")) {
    if (line.length > 0) {
      renderer.showSystem(line, "info");
    }
  }
}
