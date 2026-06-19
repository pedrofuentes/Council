/**
 * PDF extractor (T6).
 *
 * Parses .pdf buffers with pdfjs-dist's Node-compatible legacy build,
 * with eval disabled and worker/canvas/system-font integrations turned
 * off. Pages are walked sequentially and their `TextItem.str` fields
 * joined with single spaces; pages are then joined with a "\n\n---\n\n"
 * separator so downstream consumers can recover page boundaries.
 *
 * Failure modes map to typed `ExtractionError` kinds:
 *   - PasswordException → "encrypted-document"
 *   - InvalidPDFException / malformed buffers → "corrupt-document"
 *   - numPages > MAX_PAGES → "oversize-file"
 *
 * Self-registers for `.pdf` via the registry's lazy loader.
 */
import { ExtractionError } from "./errors.js";
import { registerExtractor } from "./registry.js";
import type {
  ContentExtractor,
  DocumentMetadata,
  ExtractedContent,
  ExtractionContext,
} from "./types.js";

const MAX_PAGES = 5000;
const PAGE_SEPARATOR = "\n\n---\n\n";

interface PdfTextItem {
  readonly str: string;
}

interface PdfTextContent {
  readonly items: readonly unknown[];
}

interface PdfPage {
  getTextContent(): Promise<PdfTextContent>;
}

interface PdfMetadataResult {
  readonly info?: Readonly<Record<string, unknown>>;
}

interface PdfDocument {
  readonly numPages: number;
  getPage(n: number): Promise<PdfPage>;
  getMetadata(): Promise<PdfMetadataResult>;
}

interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

interface PdfJsModule {
  getDocument(opts: {
    data: Uint8Array;
    isEvalSupported: boolean;
    useWorkerFetch: boolean;
    isOffscreenCanvasSupported: boolean;
    useSystemFonts: boolean;
    verbosity: number;
  }): PdfLoadingTask;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((t) => t.length > 0).length;
}

function isTextItem(item: unknown): item is PdfTextItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "str" in item &&
    typeof (item as { str: unknown }).str === "string"
  );
}

function readStringField(
  info: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  if (info === undefined) return undefined;
  const value = info[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: unknown }).name === "AbortError"
  );
}

function classifyPdfError(err: unknown, filename: string): ExtractionError {
  const name =
    typeof err === "object" && err !== null && "name" in err
      ? String((err as { name: unknown }).name)
      : "";
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "Unknown PDF parsing error";

  if (name === "PasswordException") {
    return new ExtractionError({
      kind: "encrypted-document",
      filePath: filename,
      message: `PDF is password-protected: ${message}`,
      suggestion: "Provide an unencrypted copy of the PDF.",
      cause: err,
    });
  }
  return new ExtractionError({
    kind: "corrupt-document",
    filePath: filename,
    message: `Failed to parse PDF: ${message}`,
    suggestion: "The file may be corrupt or not a valid PDF.",
    cause: err,
  });
}

const pdfExtractor: ContentExtractor = async (
  ctx: ExtractionContext,
): Promise<ExtractedContent> => {
  if (ctx.signal !== undefined && ctx.signal.aborted) {
    throw new ExtractionError({
      kind: "extraction-timeout",
      filePath: ctx.filename,
      message: "PDF extraction aborted before it began.",
      cause: ctx.signal.reason,
    });
  }

  const pdfjsLib = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJsModule;

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(ctx.buffer),
    isEvalSupported: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });

  let pdf: PdfDocument | undefined;
  try {
    pdf = await loadingTask.promise;
    const pageCount = pdf.numPages;
    if (pageCount > MAX_PAGES) {
      throw new ExtractionError({
        kind: "oversize-file",
        filePath: ctx.filename,
        message: `PDF has ${pageCount} pages, exceeds limit of ${MAX_PAGES}.`,
        suggestion: "Split the PDF into smaller files.",
      });
    }

    const pages: string[] = [];
    for (let i = 1; i <= pageCount; i++) {
      if (ctx.signal !== undefined && ctx.signal.aborted) {
        throw new ExtractionError({
          kind: "extraction-timeout",
          filePath: ctx.filename,
          message: `PDF extraction aborted at page ${i} of ${pageCount}.`,
          cause: ctx.signal.reason,
        });
      }
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .filter(isTextItem)
        .map((item) => item.str)
        .join(" ");
      pages.push(pageText);
    }

    const content = pages.join(PAGE_SEPARATOR).trim();

    let metadata: DocumentMetadata = { pageCount };
    try {
      const info = await pdf.getMetadata();
      const title = readStringField(info.info, "Title");
      const author = readStringField(info.info, "Author");
      metadata = {
        pageCount,
        ...(title !== undefined ? { title } : {}),
        ...(author !== undefined ? { author } : {}),
      };
    } catch {
      // Metadata is best-effort; page count alone is still useful.
    }

    return { content, wordCount: countWords(content), metadata };
  } catch (err) {
    if (err instanceof ExtractionError) throw err;
    if (isAbortError(err)) {
      throw new ExtractionError({
        kind: "extraction-timeout",
        filePath: ctx.filename,
        message: "PDF extraction aborted.",
        cause: err,
      });
    }
    throw classifyPdfError(err, ctx.filename);
  } finally {
    // pdfjs-dist v6 removed PDFDocumentProxy.destroy(); destroying the
    // loading task tears down the document, transport, and worker.
    await loadingTask.destroy().catch(() => undefined);
  }
};

registerExtractor([".pdf"], async () => pdfExtractor);
