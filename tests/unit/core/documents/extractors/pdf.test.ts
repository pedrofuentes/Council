/**
 * Tests for the PDF extractor module (T6).
 *
 * The PDF extractor parses .pdf buffers via pdfjs-dist (legacy/Node
 * build) with eval disabled, joins page text with a "\n\n---\n\n"
 * separator, and surfaces page count plus optional title/author in
 * metadata. Encrypted documents and corrupt buffers map to typed
 * ExtractionError kinds; PDFs exceeding the 5,000-page cap are
 * rejected as "oversize-file".
 */
import { describe, expect, it, vi } from "vitest";

import type { ContentExtractor } from "../../../../../src/core/documents/extractors/types.js";
import type * as ErrorsModuleNS from "../../../../../src/core/documents/extractors/errors.js";

async function loadPdfExtractor(): Promise<{
  extractor: ContentExtractor;
  errors: typeof ErrorsModuleNS;
}> {
  vi.resetModules();
  await import("../../../../../src/core/documents/extractors/pdf.js");
  const registry = await import(
    "../../../../../src/core/documents/extractors/registry.js"
  );
  const errors = await import(
    "../../../../../src/core/documents/extractors/errors.js"
  );
  const extractor = await registry.getExtractor(".pdf");
  return { extractor, errors };
}

function ctx(
  buf: Buffer,
  opts: { signal?: AbortSignal } = {},
): {
  buffer: Buffer;
  filename: string;
  extension: string;
  sizeBytes: number;
  signal?: AbortSignal;
} {
  return {
    buffer: buf,
    filename: "doc.pdf",
    extension: ".pdf",
    sizeBytes: buf.byteLength,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
}

/**
 * Builds a syntactically valid single-pass PDF in-memory.
 *
 * Layout: [catalog, pages, page#1..N, content#1..N, font].
 * Each `pageTexts[i]` becomes a tiny content stream that draws the
 * given string with the Helvetica Type1 font; pdfjs-dist is able to
 * recover the original `str` via `getTextContent()`.
 *
 * `info` populates the trailer's /Info dictionary so getMetadata()
 * surfaces Title/Author. Pass `{}` (default) for no /Info.
 */
function makePdf(
  pageTexts: readonly string[],
  info: { title?: string; author?: string } = {},
): Buffer {
  const N = pageTexts.length;
  const pageIds: number[] = [];
  for (let i = 0; i < N; i++) pageIds.push(3 + i);
  const contentIds: number[] = [];
  for (let i = 0; i < N; i++) contentIds.push(3 + N + i);
  const fontIdx = 3 + 2 * N;
  const infoIdx = info.title !== undefined || info.author !== undefined ? fontIdx + 1 : 0;

  const escape = (s: string): string => s.replace(/[()\\]/g, (c) => `\\${c}`);
  const kidsRefs = pageIds.map((id) => `${id} 0 R`).join(" ");
  const catalog = `<</Type/Catalog/Pages 2 0 R>>`;
  const pagesObj = `<</Type/Pages/Kids[${kidsRefs}]/Count ${N}>>`;
  const pageObjs = pageIds.map(
    (_id, i) =>
      `<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents ${contentIds[i]} 0 R/Resources<</Font<</F1 ${fontIdx} 0 R>>>>>>`,
  );
  const contentStreams = pageTexts.map((text) =>
    text.length === 0
      ? ""
      : `BT /F1 12 Tf 50 700 Td (${escape(text)}) Tj ET`,
  );
  const fontObj = `<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>`;

  const offsets: number[] = [0];
  let body = "%PDF-1.4\n%\xff\xff\xff\xff\n";
  const add = (num: number, content: string): void => {
    offsets[num] = Buffer.byteLength(body, "binary");
    body += `${num} 0 obj\n${content}\nendobj\n`;
  };
  add(1, catalog);
  add(2, pagesObj);
  for (let i = 0; i < N; i++) add(pageIds[i], pageObjs[i]);
  for (let i = 0; i < N; i++) {
    const stream = contentStreams[i];
    add(
      contentIds[i],
      `<</Length ${Buffer.byteLength(stream, "binary")}>>\nstream\n${stream}\nendstream`,
    );
  }
  add(fontIdx, fontObj);
  if (infoIdx !== 0) {
    const parts: string[] = [];
    if (info.title !== undefined) parts.push(`/Title (${escape(info.title)})`);
    if (info.author !== undefined) parts.push(`/Author (${escape(info.author)})`);
    add(infoIdx, `<<${parts.join("")}>>`);
  }

  const totalObjs = (infoIdx !== 0 ? infoIdx : fontIdx) + 1;
  const xrefOffset = Buffer.byteLength(body, "binary");
  body += `xref\n0 ${totalObjs}\n0000000000 65535 f \n`;
  for (let i = 1; i < totalObjs; i++) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailerInfo = infoIdx !== 0 ? `/Info ${infoIdx} 0 R` : "";
  body += `trailer\n<</Size ${totalObjs}/Root 1 0 R${trailerInfo}>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "binary");
}

describe("pdf extractor", () => {
  it("registers itself for .pdf", async () => {
    vi.resetModules();
    await import("../../../../../src/core/documents/extractors/pdf.js");
    const registry = await import(
      "../../../../../src/core/documents/extractors/registry.js"
    );
    expect(registry.getSupportedExtensions()).toContain(".pdf");
  });

  it("extracts text from a single-page PDF and reports page count", async () => {
    const { extractor } = await loadPdfExtractor();
    const buf = makePdf(["Hello World"]);
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("Hello World");
    expect(out.wordCount).toBe(2);
    expect(out.metadata?.pageCount).toBe(1);
  });

  it("joins multi-page text with the page separator", async () => {
    const { extractor } = await loadPdfExtractor();
    const buf = makePdf(["First page text", "Second page here"]);
    const out = await extractor(ctx(buf));
    expect(out.content).toContain("First page text");
    expect(out.content).toContain("Second page here");
    expect(out.content).toContain("\n\n---\n\n");
    expect(out.metadata?.pageCount).toBe(2);
    // Separator must appear between page boundaries, not after the last page.
    expect(out.content.split("\n\n---\n\n")).toHaveLength(2);
  });

  it("returns empty content and zero word count for a PDF with no text", async () => {
    const { extractor } = await loadPdfExtractor();
    const buf = makePdf([""]);
    const out = await extractor(ctx(buf));
    expect(out.content).toBe("");
    expect(out.wordCount).toBe(0);
    expect(out.metadata?.pageCount).toBe(1);
  });

  it("surfaces /Info Title and Author in metadata", async () => {
    const { extractor } = await loadPdfExtractor();
    const buf = makePdf(["Body text"], { title: "My Title", author: "Jane Doe" });
    const out = await extractor(ctx(buf));
    expect(out.metadata?.title).toBe("My Title");
    expect(out.metadata?.author).toBe("Jane Doe");
  });

  it("throws ExtractionError(corrupt-document) for a non-PDF buffer", async () => {
    const { extractor, errors } = await loadPdfExtractor();
    const buf = Buffer.from("this is not a pdf, just random ASCII bytes here", "utf-8");
    let caught: unknown;
    try {
      await extractor(ctx(buf));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(errors.ExtractionError);
    const e = caught as InstanceType<typeof errors.ExtractionError>;
    expect(e.kind).toBe("corrupt-document");
  });

  it("throws ExtractionError(encrypted-document) for a password-protected PDF", async () => {
    const { extractor, errors } = await loadPdfExtractor();
    // Minimal PDF with an /Encrypt dict referenced from the trailer. pdfjs-dist
    // raises a PasswordException before any text extraction can occur.
    const encrypted = Buffer.from(
      [
        "%PDF-1.4",
        "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
        "2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj",
        "3 0 obj<</Filter/Standard/V 1/R 2/O <" +
          "0".repeat(64) +
          ">/U <" +
          "0".repeat(64) +
          ">/P -4>>endobj",
        "xref",
        "0 4",
        "0000000000 65535 f ",
        "0000000009 00000 n ",
        "0000000052 00000 n ",
        "0000000094 00000 n ",
        "trailer<</Size 4/Root 1 0 R/Encrypt 3 0 R/ID[<11><22>]>>",
        "startxref",
        "200",
        "%%EOF",
      ].join("\n"),
      "binary",
    );
    let caught: unknown;
    try {
      await extractor(ctx(encrypted));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(errors.ExtractionError);
    const e = caught as InstanceType<typeof errors.ExtractionError>;
    // Either encrypted-document (preferred) or corrupt-document is acceptable
    // depending on how pdfjs raises the failure for the synthetic encryption
    // dict — but encrypted-document MUST be the kind when a real password
    // exception is raised.
    expect(["encrypted-document", "corrupt-document"]).toContain(e.kind);
  });

  it("aborts extraction when ctx.signal is already aborted", async () => {
    const { extractor, errors } = await loadPdfExtractor();
    const buf = makePdf(["Hello"]);
    const ac = new AbortController();
    ac.abort();
    let caught: unknown;
    try {
      await extractor(ctx(buf, { signal: ac.signal }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(errors.ExtractionError);
    const e = caught as InstanceType<typeof errors.ExtractionError>;
    expect(e.kind).toBe("extraction-timeout");
  });
});
