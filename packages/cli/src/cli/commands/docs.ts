/**
 * Top-level `council docs` command (T13 + T14).
 *
 * Subcommands:
 *   - `formats` — lists supported file types, AI extraction status and
 *     file size limit, sourced from the live extractor registry and
 *     user config.
 *   - `review <panel>` — lists files in a panel's docs corpus that
 *     couldn't be auto-processed (failed extraction, unsupported
 *     format) and flags AI-extraction-eligible ones when enabled.
 *     Exits non-zero when there is something pending review so CI /
 *     scripts can detect a degraded corpus.
 *   - `doctor <panel>` — diagnostic health summary for a panel: total
 *     indexed documents + word count, pending review count, corrupt
 *     count, configured AI-extraction mode and file size limit.
 *
 * `review` and `doctor` share a `DocsCommandDeps` injection seam so
 * unit tests can stub the panel-scan and config-load steps without
 * spinning up a real database or filesystem corpus. The default
 * `scanPanel` opens the council database, verifies the panel exists in
 * the library and runs `scanAndIndexPanelDocuments` against the
 * panel's managed docs folder.
 */
import * as path from "node:path";

import { Command } from "commander";

import { CliUserError } from "../cli-user-error.js";
import {
  ensureDataDirectories,
  getCouncilDataHome,
  getCouncilHome,
  loadConfig,
  type CouncilConfig,
} from "../../config/index.js";
import { getSupportedExtensions } from "../../core/documents/extractors/index.js";
import { isExtensionAiEligible } from "../../core/documents/extractors/ai-fallback.js";
import {
  scanAndIndexPanelDocuments,
  type PanelScanResult,
} from "../../core/documents/panel-document-scanner.js";
import { describeScanError } from "../formatters/scan-summary.js";
import { toSingleLineDisplay } from "../strip-control-chars.js";
import { createDatabase } from "../../memory/db.js";
import { PanelLibraryRepository } from "../../memory/repositories/panel-library-repo.js";

import {
  createReadlineConfirmProvider,
  type ConfirmProvider,
} from "./confirm.js";
import { defaultErrorWriter, defaultWriter, type Writer } from "./writer.js";

/**
 * Strip C0/C1 control characters (including ANSI escapes) from
 * untrusted config values before printing to the terminal.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;
function sanitize(s: string): string {
  return s.replace(CONTROL_CHARS, "");
}

/**
 * Sanitize AI-fallback-derived text (e.g. `detectedFormat`) for terminal
 * display via the shared `stripControlChars` (ANSI/OSC + C0/C1 + bidi),
 * collapsing residual newlines/tabs so one value cannot leak onto extra
 * lines. Used for needs-review output — never print AI text unsanitized.
 */
function sanitizeAiText(s: string): string {
  return toSingleLineDisplay(s).trim();
}

const NATIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".html",
  ".htm",
]);

const EXTENSION_LABELS: Readonly<Record<string, string>> = {
  ".md": "Markdown",
  ".markdown": "Markdown",
  ".txt": "Plain text",
  ".html": "HTML",
  ".htm": "HTML",
  ".pdf": "PDF",
  ".docx": "Word document",
  ".pptx": "PowerPoint presentation",
  ".xlsx": "Excel spreadsheet",
  ".xls": "Legacy Excel (re-save as .xlsx recommended)",
  ".csv": "Comma-separated values",
  ".tsv": "Tab-separated values",
  ".rtf": "Rich Text Format",
  ".odt": "OpenDocument Text",
  ".ods": "OpenDocument Spreadsheet",
  ".odp": "OpenDocument Presentation",
};

interface CategorizedExtensions {
  readonly native: readonly string[];
  readonly rich: readonly string[];
}

function categorizeExtensions(
  extensions: readonly string[],
): CategorizedExtensions {
  const native: string[] = [];
  const rich: string[] = [];
  for (const ext of [...extensions].sort()) {
    if (NATIVE_EXTENSIONS.has(ext)) {
      native.push(ext);
    } else {
      rich.push(ext);
    }
  }
  return { native, rich };
}

function describeExtension(ext: string): string {
  return EXTENSION_LABELS[ext] ?? ext.replace(/^\./, "").toUpperCase();
}

function formatExtensionLine(ext: string, width: number): string {
  return `  ${ext.padEnd(width)}  ${describeExtension(ext)}\n`;
}

function maxExtensionWidth(extensions: readonly string[]): number {
  let width = 0;
  for (const ext of extensions) {
    if (ext.length > width) width = ext.length;
  }
  return width;
}

export function buildDocsCommand(
  write: Writer = defaultWriter,
  writeError: Writer = defaultErrorWriter,
  deps: DocsCommandDeps = {},
): Command {
  const cmd = new Command("docs");
  cmd.description("Document format reference and discoverability helpers");
  cmd.addCommand(buildFormatsCommand(write, writeError));
  cmd.addCommand(buildReviewCommand(write, writeError, deps));
  cmd.addCommand(buildExtractCommand(write, writeError, deps));
  cmd.addCommand(buildDoctorCommand(write, writeError, deps));
  return cmd;
}

function buildFormatsCommand(write: Writer, _writeError: Writer): Command {
  const cmd = new Command("formats");
  cmd
    .description("List supported document formats")
    .action(async () => {
      const config = await loadConfig();
      const registered = getSupportedExtensions();
      const { native, rich } = categorizeExtensions(registered);
      const width = maxExtensionWidth(registered);

      write("Supported Document Formats\n\n");

      write("Native (text-based, no conversion needed):\n");
      if (native.length === 0) {
        write("  (none registered)\n");
      } else {
        for (const ext of native) write(formatExtensionLine(ext, width));
      }
      write("\n");

      write("Rich Documents (converted to text):\n");
      if (rich.length === 0) {
        write("  (none registered)\n");
      } else {
        for (const ext of rich) write(formatExtensionLine(ext, width));
      }
      write("\n");

      const aiMode = sanitize(config.documents.aiExtraction);
      const allowed = config.documents.aiExtractionAllowedExtensions.map(sanitize);
      write("AI Extraction (experimental):\n");
      write(
        "  What it is: builds a structured text description of files no native\n" +
          "    extractor can read, so experts can still reference them (it never\n" +
          "    sends your files to an external AI service).\n",
      );
      write(
        "  When to enable: turn it on for panels that need otherwise-unreadable\n" +
          "    files — 'ask' holds each file for your approval (run `council docs\n" +
          "    extract <panel>`), 'auto' extracts and indexes them automatically.\n",
      );
      write(`  Status: ${aiMode}\n`);
      if (allowed.length > 0) {
        write(`  Allowed extensions: ${allowed.join(", ")}\n`);
      }
      write(
        "  Configure: council config set documents.aiExtraction off|ask|auto\n",
      );
      write(
        "  Limit to specific types: council config set documents.aiExtractionAllowedExtensions .ext1,.ext2\n",
      );
      write("\n");

      const limitMb = config.documents.maxFileSizeMB;
      write(
        `File size limit: ${limitMb} MB (configure: council config set documents.maxFileSizeMB <value>)\n`,
      );
    });
  return cmd;
}

// ──────────────────────────────────────────────────────────────────────
// docs review / docs doctor (T14)
// ──────────────────────────────────────────────────────────────────────

/**
 * Result of looking up a panel and scanning its docs corpus. The
 * "not-found" arm lets callers render a friendly error instead of
 * surfacing a raw `findByName` null check.
 */
export type PanelScanLookupResult =
  | { readonly kind: "not-found" }
  | { readonly kind: "scanned"; readonly result: PanelScanResult };

export interface DocsCommandDeps {
  /** Override the panel scan step (used by tests to avoid DB + FS). */
  readonly scanPanel?: (panelName: string) => Promise<PanelScanLookupResult>;
  /** Override config loading (used by tests). */
  readonly loadConfigFn?: () => Promise<CouncilConfig>;
  /**
   * Override the AI-extraction run used by `docs extract`. Defaults to a
   * scan-and-index pass with the AI fallback forced to `auto` — i.e. the
   * SAME extraction path `auto` mode uses, only gated behind the
   * `docs extract` confirmation prompt. Injected by tests to assert the
   * extraction path is invoked on confirm and skipped on decline.
   */
  readonly extractPanel?: (panelName: string) => Promise<PanelScanLookupResult>;
  /**
   * Factory for the confirmation prompt used by `docs extract`. When
   * omitted, a readline-backed default is used. Injected by tests.
   */
  readonly confirmProvider?: () => ConfirmProvider;
}

async function scanPanelWithMode(
  panelName: string,
  modeOverride?: "off" | "ask" | "auto",
): Promise<PanelScanLookupResult> {
  const config = await loadConfig();
  const dataHome = getCouncilDataHome(config);
  await ensureDataDirectories(dataHome);
  const dbPath = path.join(getCouncilHome(), "council.db");
  const db = await createDatabase(dbPath);
  try {
    const panelRepo = new PanelLibraryRepository(db);
    const panel = await panelRepo.findByName(panelName);
    if (!panel) {
      return { kind: "not-found" };
    }
    const managedDocsDir = path.join(dataHome, "panels", panelName, "docs");
    const result = await scanAndIndexPanelDocuments({
      panelName,
      managedDocsDir,
      db,
      supportedFormats: config.expert.supportedFormats,
      maxFileSizeBytes: config.documents.maxFileSizeMB * 1024 * 1024,
      aiFallback: {
        mode: modeOverride ?? config.documents.aiExtraction,
        allowedExtensions: config.documents.aiExtractionAllowedExtensions,
      },
    });
    return { kind: "scanned", result };
  } finally {
    await db.destroy();
  }
}

async function defaultScanPanel(panelName: string): Promise<PanelScanLookupResult> {
  return scanPanelWithMode(panelName);
}

/**
 * Default extraction run for `docs extract`. Re-scans the panel with the
 * AI fallback forced to `auto`, which makes the EXISTING extraction path
 * index the files that `ask` mode previously held as needs-review. No new
 * AI/engine integration is introduced — this gates `auto`-mode behavior
 * behind the `docs extract` confirmation prompt.
 */
async function defaultExtractPanel(
  panelName: string,
): Promise<PanelScanLookupResult> {
  return scanPanelWithMode(panelName, "auto");
}

function isAiExtractionEligible(
  file: ScanFileDetailLike,
  aiMode: "off" | "ask" | "auto",
  allowedExtensions: readonly string[],
): boolean {
  // Only unsupported-format files are AI-extraction candidates (corrupt /
  // encrypted / too-large files are not). Beyond that, defer to the AI
  // fallback's own eligibility rule — the single source of truth shared
  // with the scanner — so this label can never claim extraction is
  // available for a file the scanner would refuse to extract (e.g. a
  // blocklisted archive or image). Keeping both checks in one place is
  // what prevents the label and the extract path from drifting.
  if (file.errorKind !== "unsupported-format") return false;
  return isExtensionAiEligible(file.extension, {
    mode: aiMode,
    allowedExtensions,
  });
}

/**
 * Subset of `ScanFileDetail` used by review/doctor renderers. Kept
 * narrow so unit tests can construct fixtures without supplying every
 * optional field.
 */
interface ScanFileDetailLike {
  readonly filename: string;
  readonly extension: string;
  readonly errorKind?: string;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function buildReviewCommand(
  write: Writer,
  writeError: Writer,
  deps: DocsCommandDeps,
): Command {
  const cmd = new Command("review");
  cmd
    .description("Review files in a panel's docs corpus that couldn't be auto-processed")
    .argument("<panel>", "Panel name")
    .action(async (panel: string) => {
      const scanFn = deps.scanPanel ?? defaultScanPanel;
      const configFn = deps.loadConfigFn ?? loadConfig;

      const [lookup, config] = await Promise.all([scanFn(panel), configFn()]);

      if (lookup.kind === "not-found") {
        writeError(`Panel "${panel}" not found.\n`);
        const err = new CliUserError(`Panel "${panel}" not found.`);
        err.exitCode = 1;
        throw err;
      }

      const failed = lookup.result.files.filter((f) => f.status === "failed");
      const needsReview = lookup.result.files.filter(
        (f) => f.status === "needs-review",
      );
      if (failed.length === 0 && needsReview.length === 0) {
        write(`Panel "${panel}": no files need review — all files are indexed.\n`);
        return;
      }

      const aiMode = config.documents.aiExtraction;
      const allowed = config.documents.aiExtractionAllowedExtensions;
      const pending = failed.length + needsReview.length;

      write(
        `Panel "${panel}" has ${pending} ${pending === 1 ? "file" : "files"} that need review:\n\n`,
      );
      let suggestFormats = false;
      for (const file of failed) {
        const kind = file.errorKind ?? "extraction-failed";
        const reason = describeScanError(kind, {
          maxFileSizeMB: config.documents.maxFileSizeMB,
          ...(file.extension.length > 0 ? { extension: file.extension } : {}),
        });
        const eligible = isAiExtractionEligible(file, aiMode, allowed);
        const tag = eligible ? "  — AI extraction available" : "";
        const marker = kind === "unsupported-format" ? "✘" : "⚠";
        write(`  ${marker} ${file.filename} — ${reason}${tag}\n`);
        if (kind === "unsupported-format") suggestFormats = true;
      }
      for (const file of needsReview) {
        const detected =
          file.detectedFormat !== undefined
            ? sanitizeAiText(file.detectedFormat)
            : "";
        const suffix = detected.length > 0 ? ` — ${detected}` : "";
        write(`  ⚠ ${file.filename} — awaiting AI-extraction review${suffix}\n`);
      }
      if (needsReview.length > 0) {
        // Make the `ask` contract explicit: these files were flagged, not
        // silently AI-extracted. `ask` means review — nothing was indexed.
        write(
          `\n'ask' mode flags AI-extractable files for review — none were auto-extracted or indexed.\n`,
        );
        // Point the user at the actionable command so `ask` mode is no
        // longer a dead-end (F07): `docs extract` prompts for confirmation
        // and then runs the extraction.
        write(
          `Run \`council docs extract ${panel}\` to extract them (you'll be asked to confirm).\n`,
        );
      }
      if (suggestFormats) {
        write(`\nRun \`council docs formats\` to see supported file types.\n`);
      }
      if (aiMode === "off") {
        write(
          `Enable AI extraction with: council config set documents.aiExtraction ask\n`,
        );
      }
      const err = new CliUserError(
        `Panel "${panel}" has ${pending} file(s) pending review.`,
      );
      err.exitCode = 1;
      throw err;
    });
  return cmd;
}

function buildExtractCommand(
  write: Writer,
  writeError: Writer,
  deps: DocsCommandDeps,
): Command {
  const cmd = new Command("extract");
  cmd
    .description(
      "Run AI extraction on files a panel is holding for review (ask mode)",
    )
    .argument("<panel>", "Panel name")
    .action(async (panel: string) => {
      const scanFn = deps.scanPanel ?? defaultScanPanel;
      const configFn = deps.loadConfigFn ?? loadConfig;

      const [lookup, config] = await Promise.all([scanFn(panel), configFn()]);

      if (lookup.kind === "not-found") {
        writeError(`Panel "${panel}" not found.\n`);
        const err = new CliUserError(`Panel "${panel}" not found.`);
        err.exitCode = 1;
        throw err;
      }

      // `off` has nothing to extract — eligibility requires a non-off
      // mode. Guide the user to enable AI extraction rather than dead-end.
      if (config.documents.aiExtraction === "off") {
        write(
          `AI extraction is disabled (mode: off).\n` +
            `Enable it with: council config set documents.aiExtraction ask\n`,
        );
        return;
      }

      const needsReview = lookup.result.files.filter(
        (f) => f.status === "needs-review",
      );
      if (needsReview.length === 0) {
        write(`Panel "${panel}": no files awaiting AI-extraction review.\n`);
        return;
      }

      write(
        `Panel "${panel}" has ${needsReview.length} ${needsReview.length === 1 ? "file" : "files"} awaiting AI extraction:\n\n`,
      );
      for (const file of needsReview) {
        const detected =
          file.detectedFormat !== undefined
            ? sanitizeAiText(file.detectedFormat)
            : "";
        const suffix = detected.length > 0 ? ` — ${detected}` : "";
        write(`  ⚠ ${file.filename}${suffix}\n`);
      }
      write("\n");

      const provider = deps.confirmProvider
        ? deps.confirmProvider()
        : createReadlineConfirmProvider();
      const confirmed = await provider.confirm(
        `Run AI extraction on ${needsReview.length} ${needsReview.length === 1 ? "file" : "files"}? [y/N] `,
      );
      if (!confirmed) {
        write("Aborted. No files were extracted.\n");
        return;
      }

      // Confirmed: run the EXISTING extraction path (auto-mode
      // scan-and-index) so the held files are extracted and indexed.
      const extractFn = deps.extractPanel ?? defaultExtractPanel;
      const extractLookup = await extractFn(panel);
      if (extractLookup.kind === "not-found") {
        writeError(`Panel "${panel}" not found.\n`);
        const err = new CliUserError(`Panel "${panel}" not found.`);
        err.exitCode = 1;
        throw err;
      }

      const indexed = extractLookup.result.indexed;
      write(
        `AI extraction complete: ${indexed} ${indexed === 1 ? "file" : "files"} indexed.\n`,
      );
    });
  return cmd;
}

function buildDoctorCommand(
  write: Writer,
  writeError: Writer,
  deps: DocsCommandDeps,
): Command {
  const cmd = new Command("doctor");
  cmd
    .description("Diagnostic health check for a panel's document pipeline")
    .argument("<panel>", "Panel name")
    .action(async (panel: string) => {
      const scanFn = deps.scanPanel ?? defaultScanPanel;
      const configFn = deps.loadConfigFn ?? loadConfig;

      const [lookup, config] = await Promise.all([scanFn(panel), configFn()]);

      if (lookup.kind === "not-found") {
        writeError(`Panel "${panel}" not found.\n`);
        const err = new CliUserError(`Panel "${panel}" not found.`);
        err.exitCode = 1;
        throw err;
      }

      const result = lookup.result;
      const indexedFiles = result.files.filter(
        (f) => f.status === "indexed" || f.status === "modified" || f.status === "unchanged",
      );
      // Prefer the aggregate counts (which include unchanged-but-tracked
      // files) over the length of `files` for the headline number; sum
      // word counts from the file array since the aggregates don't
      // track that.
      const indexedCount = result.indexed + result.unchanged;
      const totalWords = indexedFiles.reduce(
        (acc, f) => acc + (f.wordCount ?? 0),
        0,
      );
      const failed = result.files.filter((f) => f.status === "failed");
      const needsReview = result.files.filter((f) => f.status === "needs-review");
      const corrupt = failed.filter((f) => f.errorKind === "corrupt-document");
      const unsupported = failed.filter(
        (f) => f.errorKind === "unsupported-format",
      );
      const encrypted = failed.filter(
        (f) => f.errorKind === "encrypted-document",
      );
      const pending = failed.length + needsReview.length;

      write(`Panel "${panel}" document health:\n`);
      write(
        `  ✓ ${formatNumber(indexedCount)} ${indexedCount === 1 ? "document" : "documents"} indexed (${formatNumber(totalWords)} ${totalWords === 1 ? "word" : "words"})\n`,
      );
      const pendingMarker = pending === 0 ? "✓" : "⚠";
      write(
        `  ${pendingMarker} ${pending} ${pending === 1 ? "file" : "files"} pending review`,
      );
      if (pending > 0) {
        write(` (run 'council docs review ${panel}')`);
      }
      write(`\n`);
      if (needsReview.length > 0) {
        write(
          `  ⚠ ${needsReview.length} ${needsReview.length === 1 ? "file" : "files"} awaiting AI-extraction review\n`,
        );
      }
      if (corrupt.length > 0) {
        const names = corrupt.map((f) => f.filename).join(", ");
        write(
          `  ✘ ${corrupt.length} ${corrupt.length === 1 ? "file" : "files"} corrupt (${names})\n`,
        );
      }
      if (unsupported.length > 0) {
        const names = unsupported.map((f) => f.filename).join(", ");
        write(
          `  ✘ ${unsupported.length} ${unsupported.length === 1 ? "file" : "files"} unsupported (${names})\n`,
        );
      }
      if (encrypted.length > 0) {
        const names = encrypted.map((f) => f.filename).join(", ");
        write(
          `  🔒 ${encrypted.length} ${encrypted.length === 1 ? "file" : "files"} encrypted/password-protected (${names})\n`,
        );
      }
      if (result.managedFolderFailed) {
        write(
          `  ✘ The managed docs folder could not be scanned — check permissions and that the path exists.\n`,
        );
      }
      const linkedFailed =
        result.foldersFailed - (result.managedFolderFailed ? 1 : 0);
      if (linkedFailed > 0) {
        write(
          `  ✘ ${linkedFailed} linked ${linkedFailed === 1 ? "folder" : "folders"} could not be scanned.\n`,
        );
      }
      write(`  ℹ AI extraction: ${config.documents.aiExtraction}\n`);
      write(`  ℹ File size limit: ${config.documents.maxFileSizeMB} MB\n`);
    });
  return cmd;
}
