/**
 * Tests for ConfigSchema document-extraction settings:
 *   - `expert.supportedFormats` default list (only extensions whose
 *     extractor is registered on `main` — ODF formats are excluded
 *     until the ODF extractors land)
 *   - `documents.maxFileSizeMB` field with bounds (lives in the
 *     `documents` section because it governs document extraction,
 *     not per-expert behavior; also matches what `extractor.ts`
 *     already references in its docs and error suggestion text)
 *   - `documents.aiExtraction` + `aiExtractionAllowedExtensions`
 *
 * These tests exercise schema parsing only — no file I/O.
 */
import { describe, expect, it } from "vitest";

import { ConfigSchema } from "../../../src/config/index.js";

describe("ConfigSchema — document extraction defaults", () => {
  it("expert.supportedFormats default lists only registered extractor extensions (no ODF)", () => {
    const config = ConfigSchema.parse({});
    expect(config.expert.supportedFormats).toEqual([
      ".md",
      ".txt",
      ".html",
      ".pdf",
      ".csv",
      ".tsv",
      ".rtf",
      ".docx",
      ".pptx",
      ".xlsx",
      ".xls",
    ]);
    // Defensive: ODF extensions must not be advertised until their
    // extractors are registered (T10, separate PR).
    expect(config.expert.supportedFormats).not.toContain(".odt");
    expect(config.expert.supportedFormats).not.toContain(".ods");
    expect(config.expert.supportedFormats).not.toContain(".odp");
  });

  it("expert.supportedFormats accepts a string array override", () => {
    const config = ConfigSchema.parse({
      expert: { supportedFormats: [".md", ".pdf"] },
    });
    expect(config.expert.supportedFormats).toEqual([".md", ".pdf"]);
  });

  it("expert.supportedFormats rejects non-string array elements", () => {
    expect(() => ConfigSchema.parse({ expert: { supportedFormats: [".md", 42] } })).toThrow();
    expect(() => ConfigSchema.parse({ expert: { supportedFormats: ".md" } })).toThrow();
  });
});

describe("ConfigSchema — documents.maxFileSizeMB", () => {
  it("defaults to 50", () => {
    const config = ConfigSchema.parse({});
    expect(config.documents.maxFileSizeMB).toBe(50);
  });

  it("accepts the lower bound of 1", () => {
    const config = ConfigSchema.parse({ documents: { maxFileSizeMB: 1 } });
    expect(config.documents.maxFileSizeMB).toBe(1);
  });

  it("accepts the upper bound of 500", () => {
    const config = ConfigSchema.parse({ documents: { maxFileSizeMB: 500 } });
    expect(config.documents.maxFileSizeMB).toBe(500);
  });

  it("rejects values below the minimum", () => {
    expect(() => ConfigSchema.parse({ documents: { maxFileSizeMB: 0 } })).toThrow();
    expect(() => ConfigSchema.parse({ documents: { maxFileSizeMB: -10 } })).toThrow();
  });

  it("rejects values above the maximum", () => {
    expect(() => ConfigSchema.parse({ documents: { maxFileSizeMB: 501 } })).toThrow();
    expect(() => ConfigSchema.parse({ documents: { maxFileSizeMB: 10000 } })).toThrow();
  });

  it("rejects non-numeric values", () => {
    expect(() => ConfigSchema.parse({ documents: { maxFileSizeMB: "50" } })).toThrow();
  });

  it("is exposed on the documents section, not on expert", () => {
    const config = ConfigSchema.parse({});
    // The field belongs in `documents` (matches extractor.ts JSDoc and
    // error suggestion text). It must NOT also appear on expert.
    expect(config.documents).toHaveProperty("maxFileSizeMB");
    expect(config.expert).not.toHaveProperty("maxFileSizeMB");
  });
});

describe("ConfigSchema — documents section", () => {
  it("applies defaults when input is empty", () => {
    const config = ConfigSchema.parse({});
    expect(config.documents.aiExtraction).toBe("off");
    expect(config.documents.aiExtractionAllowedExtensions).toEqual([]);
  });

  it("accepts aiExtraction='off'", () => {
    const config = ConfigSchema.parse({ documents: { aiExtraction: "off" } });
    expect(config.documents.aiExtraction).toBe("off");
  });

  it("accepts aiExtraction='ask'", () => {
    const config = ConfigSchema.parse({ documents: { aiExtraction: "ask" } });
    expect(config.documents.aiExtraction).toBe("ask");
  });

  it("accepts aiExtraction='auto'", () => {
    const config = ConfigSchema.parse({ documents: { aiExtraction: "auto" } });
    expect(config.documents.aiExtraction).toBe("auto");
  });

  it("rejects invalid aiExtraction values", () => {
    expect(() => ConfigSchema.parse({ documents: { aiExtraction: "yes" } })).toThrow();
    expect(() => ConfigSchema.parse({ documents: { aiExtraction: "" } })).toThrow();
    expect(() => ConfigSchema.parse({ documents: { aiExtraction: true } })).toThrow();
  });

  it("accepts a list of allowed extensions", () => {
    const config = ConfigSchema.parse({
      documents: {
        aiExtraction: "ask",
        aiExtractionAllowedExtensions: [".pdf", ".docx"],
      },
    });
    expect(config.documents.aiExtractionAllowedExtensions).toEqual([".pdf", ".docx"]);
  });

  it("rejects non-string entries in aiExtractionAllowedExtensions", () => {
    expect(() =>
      ConfigSchema.parse({
        documents: { aiExtractionAllowedExtensions: [".pdf", 7] },
      }),
    ).toThrow();
    expect(() =>
      ConfigSchema.parse({
        documents: { aiExtractionAllowedExtensions: ".pdf" },
      }),
    ).toThrow();
  });

  it("preserves backward-compatible parsing (no documents key)", () => {
    const config = ConfigSchema.parse({
      defaults: { maxRounds: 6 },
      expert: { supportedFormats: [".md", ".txt", ".html"] },
    });
    expect(config.documents.aiExtraction).toBe("off");
    expect(config.documents.aiExtractionAllowedExtensions).toEqual([]);
    expect(config.expert.supportedFormats).toEqual([".md", ".txt", ".html"]);
  });
});
