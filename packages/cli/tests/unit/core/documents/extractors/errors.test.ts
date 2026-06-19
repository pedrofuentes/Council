/**
 * Tests for ExtractionError taxonomy (T2).
 *
 * RED at this commit: src/core/documents/extractors/errors.ts does not
 * exist yet.
 */
import { describe, expect, it } from "vitest";

import { ExtractionError } from "../../../../../src/core/documents/extractors/errors.js";

describe("ExtractionError", () => {
  it("is an instance of Error", () => {
    const err = new ExtractionError({
      kind: "unsupported-format",
      filePath: "/tmp/foo.xyz",
      message: "no extractor for .xyz",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ExtractionError);
  });

  it("exposes kind, filePath, suggestion, and a fixed name", () => {
    const err = new ExtractionError({
      kind: "encrypted-document",
      filePath: "/tmp/secret.pdf",
      message: "password-protected",
      suggestion: "Decrypt the PDF and retry.",
    });
    expect(err.name).toBe("ExtractionError");
    expect(err.kind).toBe("encrypted-document");
    expect(err.filePath).toBe("/tmp/secret.pdf");
    expect(err.suggestion).toBe("Decrypt the PDF and retry.");
    expect(err.message).toBe("password-protected");
  });

  it("suggestion is optional", () => {
    const err = new ExtractionError({
      kind: "corrupt-document",
      filePath: "/tmp/broken.docx",
      message: "zip central directory missing",
    });
    expect(err.suggestion).toBeUndefined();
  });

  it("accepts all documented ExtractionErrorKind values", () => {
    const kinds = [
      "unsupported-format",
      "encrypted-document",
      "corrupt-document",
      "oversize-file",
      "extraction-timeout",
      "zip-bomb-detected",
      "ai-extraction-declined",
      "ai-extraction-failed",
    ] as const;
    for (const kind of kinds) {
      const err = new ExtractionError({
        kind,
        filePath: "/tmp/x",
        message: kind,
      });
      expect(err.kind).toBe(kind);
    }
  });
});
