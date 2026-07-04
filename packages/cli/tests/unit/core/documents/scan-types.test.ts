/**
 * Tests for shared scan-result helpers (Task T2).
 *
 * `unsupportedFileDetail` is the single classification point that turns a
 * path the detector flagged as an unsupported extension into a
 * `ScanFileDetail`. Both producers (expert processor + panel scanner)
 * route through it so every display surface reports unsupported files
 * identically.
 */
import { describe, expect, it } from "vitest";

import {
  classifyExtractionError,
  classifyUnsupportedFile,
  unsupportedFileDetail,
} from "../../../../src/core/documents/scan-types.js";
import { ExtractionError } from "../../../../src/core/documents/extractors/index.js";
import type { AiFallbackConfig } from "../../../../src/core/documents/extractors/ai-fallback.js";

describe("unsupportedFileDetail", () => {
  it("classifies a path as a failed, unsupported-format detail", () => {
    const detail = unsupportedFileDetail("/docs/panel/screenshot.png");
    expect(detail.path).toBe("/docs/panel/screenshot.png");
    expect(detail.filename).toBe("screenshot.png");
    expect(detail.extension).toBe(".png");
    expect(detail.status).toBe("failed");
    expect(detail.errorKind).toBe("unsupported-format");
    // The diagnostic message names the offending extension.
    expect(detail.errorMessage).toContain(".png");
  });

  it("lowercases the extension", () => {
    const detail = unsupportedFileDetail("/docs/panel/ARCHIVE.ZIP");
    expect(detail.filename).toBe("ARCHIVE.ZIP");
    expect(detail.extension).toBe(".zip");
    expect(detail.errorKind).toBe("unsupported-format");
  });

  it("handles a file with no extension", () => {
    const detail = unsupportedFileDetail("/docs/panel/Makefile");
    expect(detail.filename).toBe("Makefile");
    expect(detail.extension).toBe("");
    expect(detail.status).toBe("failed");
    expect(detail.errorKind).toBe("unsupported-format");
  });
});

// ─────────────────────────────────────────────────────────────────────
// classifyUnsupportedFile (Task T4).
//
// An unsupported-extension file (one the detector dropped because its
// extension is not in `supportedFormats`) is normally reported as an
// `unsupported` failure (T2). But when `documents.aiExtraction` is `ask`
// and the extension is eligible for AI extraction (not blocklisted, and
// allowlisted when an allowlist is configured), `ask` MUST surface it as
// an "awaiting AI-extraction review" / `needs-review` outcome instead —
// so the user can see AI extraction is available, pending their review.
// `ask` never auto-extracts or indexes: the file is only flagged.
// ─────────────────────────────────────────────────────────────────────
describe("classifyUnsupportedFile (T4)", () => {
  const ASK: AiFallbackConfig = { mode: "ask", allowedExtensions: [] };
  const OFF: AiFallbackConfig = { mode: "off", allowedExtensions: [] };
  const AUTO: AiFallbackConfig = { mode: "auto", allowedExtensions: [] };

  it("falls back to the plain unsupported detail when no AI config is given", () => {
    const detail = classifyUnsupportedFile("/docs/panel/deck.key");
    expect(detail.status).toBe("failed");
    expect(detail.errorKind).toBe("unsupported-format");
  });

  it("off mode: still reports the file as an unsupported failure (T2 unchanged)", () => {
    const detail = classifyUnsupportedFile("/docs/panel/deck.key", OFF);
    expect(detail.status).toBe("failed");
    expect(detail.errorKind).toBe("unsupported-format");
    expect(detail.extension).toBe(".key");
  });

  it("ask mode: an eligible unsupported file becomes a needs-review outcome", () => {
    const detail = classifyUnsupportedFile("/docs/panel/deck.key", ASK);
    expect(detail.status).toBe("needs-review");
    expect(detail.filename).toBe("deck.key");
    expect(detail.extension).toBe(".key");
    // Held for review (ask mode) — represented as AI-extracted per the
    // ScanFileDetail.aiExtracted contract — but NOT a failure.
    expect(detail.aiExtracted).toBe(true);
    expect(detail.errorKind).toBeUndefined();
  });

  it("ask mode: a blocklisted extension (.png) stays unsupported", () => {
    const detail = classifyUnsupportedFile("/docs/panel/shot.png", ASK);
    expect(detail.status).toBe("failed");
    expect(detail.errorKind).toBe("unsupported-format");
  });

  it("ask mode: a blocklisted archive (.zip) stays unsupported", () => {
    const detail = classifyUnsupportedFile("/docs/panel/bundle.zip", ASK);
    expect(detail.status).toBe("failed");
    expect(detail.errorKind).toBe("unsupported-format");
  });

  it("ask mode: respects a non-empty allowlist (extension not listed stays unsupported)", () => {
    const detail = classifyUnsupportedFile("/docs/panel/deck.key", {
      mode: "ask",
      allowedExtensions: [".epub"],
    });
    expect(detail.status).toBe("failed");
    expect(detail.errorKind).toBe("unsupported-format");
  });

  it("ask mode: surfaces review when the extension is in the allowlist", () => {
    const detail = classifyUnsupportedFile("/docs/panel/book.epub", {
      mode: "ask",
      allowedExtensions: [".epub"],
    });
    expect(detail.status).toBe("needs-review");
    expect(detail.extension).toBe(".epub");
  });

  it("ask mode: normalizes extension casing (.KEY is eligible)", () => {
    const detail = classifyUnsupportedFile("/docs/panel/DECK.KEY", ASK);
    expect(detail.status).toBe("needs-review");
    expect(detail.extension).toBe(".key");
  });

  it("auto mode: leaves unsupported-extension files unsupported (auto extraction of detector-dropped files is out of scope for T4)", () => {
    const detail = classifyUnsupportedFile("/docs/panel/deck.key", AUTO);
    expect(detail.status).toBe("failed");
    expect(detail.errorKind).toBe("unsupported-format");
  });
});

// ─────────────────────────────────────────────────────────────────────
// classifyExtractionError (issue #975).
//
// `classifyExtractionError` is the single point that maps an arbitrary
// thrown value into the `ScanErrorKind` taxonomy. It has three branches:
//   1. `ExtractionError` — trust the carried `kind`/`message`.
//   2. a plain error/string whose message matches a confinement/TOCTOU
//      substring — `confinement-violation`.
//   3. anything else — `extraction-failed`.
// Branch 2 is coupled BY SUBSTRING to the exact strings `extractor.ts`
// (and the panel scanner) throw, so these tests pin those literals: a
// message change at the throw site would silently mislabel a confinement
// rejection as a generic `extraction-failed`.
// ─────────────────────────────────────────────────────────────────────
describe("classifyExtractionError (#975)", () => {
  it("preserves the kind and message carried by an ExtractionError", () => {
    const err = new ExtractionError({
      kind: "corrupt-document",
      filePath: "/docs/panel/report.pdf",
      message: "unexpected EOF at byte 12",
    });
    const classified = classifyExtractionError(err);
    expect(classified.kind).toBe("corrupt-document");
    expect(classified.message).toBe("unexpected EOF at byte 12");
  });

  it("maps the extractor's TOCTOU inode message to confinement-violation", () => {
    // Mirrors extractor.ts: `${filePath} inode changed between open and realpath (TOCTOU detected)`.
    const err = new Error(
      "extractDocument: /docs/panel/a.pdf inode changed between open and realpath (TOCTOU detected)",
    );
    const classified = classifyExtractionError(err);
    expect(classified.kind).toBe("confinement-violation");
    expect(classified.message).toBe(err.message);
  });

  it("maps the extractor's 'resolves outside confinement root' message to confinement-violation", () => {
    // Mirrors extractor.ts: `${filePath} resolves outside confinement root ${root}`.
    const err = new Error(
      "extractDocument: /etc/passwd resolves outside confinement root /docs/panel",
    );
    expect(classifyExtractionError(err).kind).toBe("confinement-violation");
  });

  it("matches the 'confinement root' substring on its own", () => {
    // Mirrors the panel scanner/processor literal:
    // "rejected: outside confinement root or TOCTOU mismatch".
    expect(
      classifyExtractionError(
        new Error("rejected: outside confinement root or TOCTOU mismatch"),
      ).kind,
    ).toBe("confinement-violation");
  });

  it("matches the 'resolves outside' substring on its own", () => {
    expect(
      classifyExtractionError(new Error("path resolves outside the sandbox")).kind,
    ).toBe("confinement-violation");
  });

  it("falls back to extraction-failed for an unrelated error message", () => {
    const classified = classifyExtractionError(
      new Error("ENOSPC: no space left on device"),
    );
    expect(classified.kind).toBe("extraction-failed");
    expect(classified.message).toBe("ENOSPC: no space left on device");
  });

  it("stringifies a non-Error thrown value and falls back to extraction-failed", () => {
    const classified = classifyExtractionError("boom");
    expect(classified.kind).toBe("extraction-failed");
    expect(classified.message).toBe("boom");
  });
});
