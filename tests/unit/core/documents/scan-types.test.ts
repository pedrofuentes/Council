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

import { unsupportedFileDetail } from "../../../../src/core/documents/scan-types.js";

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
