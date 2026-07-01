/**
 * Tests for the extractor registry (T2).
 *
 * RED at this commit: src/core/documents/extractors/registry.ts does not
 * exist yet.
 *
 * The registry holds module-level state (extension → loader maps), so
 * each test imports a fresh copy via `vi.resetModules` + dynamic import
 * to keep tests order-independent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as RegistryModuleNS from "../../../../../src/core/documents/extractors/registry.js";
import type * as ErrorsModuleNS from "../../../../../src/core/documents/extractors/errors.js";
import type {
  ContentExtractor,
  ExtractedContent,
  ExtractionContext,
  ExtractorLoader,
} from "../../../../../src/core/documents/extractors/types.js";

type RegistryModule = typeof RegistryModuleNS;
type ErrorsModule = typeof ErrorsModuleNS;

async function loadRegistry(): Promise<{
  registry: RegistryModule;
  errors: ErrorsModule;
}> {
  vi.resetModules();
  const registry = await import(
    "../../../../../src/core/documents/extractors/registry.js"
  );
  const errors = await import(
    "../../../../../src/core/documents/extractors/errors.js"
  );
  return { registry, errors };
}

function makeExtractor(name: string): ContentExtractor {
  return async (_ctx: ExtractionContext): Promise<ExtractedContent> => ({
    content: name,
    wordCount: 1,
  });
}

beforeEach(() => {
  vi.resetModules();
});

describe("registerExtractor / getExtractor", () => {
  it("registers a loader for multiple extensions", async () => {
    const { registry } = await loadRegistry();
    const extractor = makeExtractor("md");
    registry.registerExtractor([".md", ".markdown"], async () => extractor);

    await expect(registry.getExtractor(".md")).resolves.toBe(extractor);
    await expect(registry.getExtractor(".markdown")).resolves.toBe(extractor);
  });

  it("throws ExtractionError(unsupported-format) for unknown extensions", async () => {
    const { registry, errors } = await loadRegistry();
    registry.registerExtractor([".md"], async () => makeExtractor("md"));

    let caught: unknown;
    try {
      await registry.getExtractor(".xyz");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(errors.ExtractionError);
    const err = caught as InstanceType<typeof errors.ExtractionError>;
    expect(err.kind).toBe("unsupported-format");
    expect(err.filePath).toBe(".xyz");
    expect(err.suggestion).toContain(".md");
  });

  it("suggests that no extractors are registered when the registry is empty", async () => {
    const { registry, errors } = await loadRegistry();

    let caught: unknown;
    try {
      await registry.getExtractor(".md");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(errors.ExtractionError);
    const err = caught as InstanceType<typeof errors.ExtractionError>;
    expect(err.kind).toBe("unsupported-format");
    expect(err.suggestion).toBe("No extractors are currently registered.");
  });

  it("memoizes resolution: loader called once for repeated lookups", async () => {
    const { registry } = await loadRegistry();
    const loader = vi.fn<ExtractorLoader>(async () => makeExtractor("md"));
    registry.registerExtractor([".md"], loader);

    const a = await registry.getExtractor(".md");
    const b = await registry.getExtractor(".md");
    const c = await registry.getExtractor(".md");

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("memoizes across alias extensions sharing the same loader", async () => {
    const { registry } = await loadRegistry();
    const loader = vi.fn<ExtractorLoader>(async () => makeExtractor("md"));
    registry.registerExtractor([".md", ".markdown"], loader);

    const a = await registry.getExtractor(".md");
    const b = await registry.getExtractor(".markdown");

    expect(a).toBe(b);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("normalizes extension lookup to lowercase", async () => {
    const { registry } = await loadRegistry();
    const extractor = makeExtractor("pdf");
    registry.registerExtractor([".pdf"], async () => extractor);

    await expect(registry.getExtractor(".PDF")).resolves.toBe(extractor);
  });
});

describe("getExtractor retry after loader rejection", () => {
  it("re-invokes the loader after a rejected load and succeeds on retry", async () => {
    const { registry } = await loadRegistry();
    const extractor = makeExtractor("md");
    const failure = new Error("transient load failure");
    const loader = vi.fn<ExtractorLoader>();
    loader.mockRejectedValueOnce(failure).mockResolvedValueOnce(extractor);
    registry.registerExtractor([".md"], loader);

    await expect(registry.getExtractor(".md")).rejects.toBe(failure);
    await expect(registry.getExtractor(".md")).resolves.toBe(extractor);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying after repeated rejections without wedging the cache", async () => {
    const { registry } = await loadRegistry();
    const first = new Error("fail 1");
    const second = new Error("fail 2");
    const loader = vi.fn<ExtractorLoader>();
    loader.mockRejectedValueOnce(first).mockRejectedValueOnce(second);
    registry.registerExtractor([".md"], loader);

    await expect(registry.getExtractor(".md")).rejects.toBe(first);
    await expect(registry.getExtractor(".md")).rejects.toBe(second);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("keeps memoizing a successfully resolved loader (eviction is rejection-scoped)", async () => {
    const { registry } = await loadRegistry();
    const extractor = makeExtractor("md");
    const loader = vi.fn<ExtractorLoader>(async () => extractor);
    registry.registerExtractor([".md"], loader);

    const a = await registry.getExtractor(".md");
    const b = await registry.getExtractor(".md");

    expect(a).toBe(extractor);
    expect(a).toBe(b);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe("getSupportedExtensions", () => {
  it("returns all registered extensions", async () => {
    const { registry } = await loadRegistry();
    registry.registerExtractor([".md", ".markdown"], async () =>
      makeExtractor("md"),
    );
    registry.registerExtractor([".pdf"], async () => makeExtractor("pdf"));

    const exts = registry.getSupportedExtensions();
    expect([...exts].sort()).toEqual([".markdown", ".md", ".pdf"].sort());
  });

  it("returns an empty list when nothing is registered", async () => {
    const { registry } = await loadRegistry();
    expect(registry.getSupportedExtensions()).toEqual([]);
  });
});

describe("detectFormatByMagicBytes", () => {
  it("returns .pdf for a %PDF header", async () => {
    const { registry } = await loadRegistry();
    const buf = Buffer.from("%PDF-1.7\n...");
    expect(registry.detectFormatByMagicBytes(buf)).toBe(".pdf");
  });

  it("returns .rtf for an RTF header", async () => {
    const { registry } = await loadRegistry();
    const buf = Buffer.from("{\\rtf1\\ansi...");
    expect(registry.detectFormatByMagicBytes(buf)).toBe(".rtf");
  });

  it("returns null for a ZIP header (ambiguous container)", async () => {
    const { registry } = await loadRegistry();
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    expect(registry.detectFormatByMagicBytes(buf)).toBeNull();
  });

  it("returns null for unknown bytes", async () => {
    const { registry } = await loadRegistry();
    const buf = Buffer.from("hello world");
    expect(registry.detectFormatByMagicBytes(buf)).toBeNull();
  });

  it("returns null for an empty buffer", async () => {
    const { registry } = await loadRegistry();
    expect(registry.detectFormatByMagicBytes(Buffer.alloc(0))).toBeNull();
  });
});
