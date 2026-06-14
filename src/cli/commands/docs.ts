/**
 * `council docs formats` — list the document formats Council can ingest.
 *
 * Reads the live extractor registry plus user configuration so the
 * output reflects exactly what the running build supports rather than a
 * static list. Categorizes registered extensions into:
 *   - Native (text-based, no conversion needed)
 *   - Rich Documents (binary/structured formats converted to text)
 *   - AI Extraction (configurable fallback for unknown formats)
 *
 * Discoverability hint: surfaces the `council config set` keys so users
 * can adjust `documents.aiExtraction` and `documents.maxFileSizeMB`
 * without leaving the help flow.
 */
import { Command } from "commander";

import { loadConfig } from "../../config/index.js";
import { getSupportedExtensions } from "../../core/documents/extractors/index.js";

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
): Command {
  const cmd = new Command("docs");
  cmd.description("Document format reference and discoverability helpers");
  cmd.addCommand(buildFormatsCommand(write, writeError));
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
      write(`  Status: ${aiMode}\n`);
      if (allowed.length > 0) {
        write(`  Allowed extensions: ${allowed.join(", ")}\n`);
      }
      write(
        "  Configure: council config set documents.aiExtraction off|ask|auto\n",
      );
      write("\n");

      const limitMb = config.documents.maxFileSizeMB;
      write(
        `File size limit: ${limitMb} MB (configure: council config set documents.maxFileSizeMB <value>)\n`,
      );
    });
  return cmd;
}
