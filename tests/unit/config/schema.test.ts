/**
 * Tests for ConfigSchema document-extraction settings:
 *   - expanded `expert.supportedFormats` default list
 *   - new `expert.maxFileSizeMB` field with bounds
 *   - new top-level `documents` section (aiExtraction + allowed extensions)
 *
 * These tests exercise schema parsing only — no file I/O.
 *
 * RED at the test commit: the schema does not yet expose these fields/defaults.
 */
import { describe, expect, it } from "vitest";

import { ConfigSchema } from "../../../src/config/index.js";

describe("ConfigSchema — document extraction defaults", () => {
  it("expert.supportedFormats default includes all document formats", () => {
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
      ".odt",
      ".ods",
      ".odp",
    ]);
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

describe("ConfigSchema — expert.maxFileSizeMB", () => {
  it("defaults to 50", () => {
    const config = ConfigSchema.parse({});
    expect(config.expert.maxFileSizeMB).toBe(50);
  });

  it("accepts the lower bound of 1", () => {
    const config = ConfigSchema.parse({ expert: { maxFileSizeMB: 1 } });
    expect(config.expert.maxFileSizeMB).toBe(1);
  });

  it("accepts the upper bound of 500", () => {
    const config = ConfigSchema.parse({ expert: { maxFileSizeMB: 500 } });
    expect(config.expert.maxFileSizeMB).toBe(500);
  });

  it("rejects values below the minimum", () => {
    expect(() => ConfigSchema.parse({ expert: { maxFileSizeMB: 0 } })).toThrow();
    expect(() => ConfigSchema.parse({ expert: { maxFileSizeMB: -10 } })).toThrow();
  });

  it("rejects values above the maximum", () => {
    expect(() => ConfigSchema.parse({ expert: { maxFileSizeMB: 501 } })).toThrow();
    expect(() => ConfigSchema.parse({ expert: { maxFileSizeMB: 10000 } })).toThrow();
  });

  it("rejects non-numeric values", () => {
    expect(() => ConfigSchema.parse({ expert: { maxFileSizeMB: "50" } })).toThrow();
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
