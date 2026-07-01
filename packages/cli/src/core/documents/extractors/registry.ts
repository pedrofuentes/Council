/**
 * Lazy-loading extractor registry (T2).
 *
 * Format-specific extractor modules self-register by calling
 * `registerExtractor([".ext", ...], async () => extractor)`. The
 * registry stores only the loader thunk so heavy dependencies (e.g. a
 * PDF parser, an unzip library) are not pulled in until first use.
 *
 * Lookups via `getExtractor` resolve and memoize the loader so that:
 *   - the loader is invoked at most once per loader instance for a
 *     given successful resolution; a rejected load is evicted from
 *     the cache so a later lookup re-invokes the loader instead of
 *     re-serving a permanently poisoned entry (successful loads
 *     remain memoized) — loaders MUST tolerate being invoked more
 *     than once, and
 *   - alias extensions sharing the same loader return the same
 *     `ContentExtractor` reference (verified by tests).
 *
 * This module deliberately imports no extractor modules; registration
 * is performed by the barrel `index.ts`.
 */
import { ExtractionError } from "./errors.js";
import type { ContentExtractor, ExtractorLoader } from "./types.js";

const loaders = new Map<string, ExtractorLoader>();
const resolved = new Map<ExtractorLoader, Promise<ContentExtractor>>();

function normalizeExt(ext: string): string {
  return ext.toLowerCase();
}

export function registerExtractor(
  extensions: readonly string[],
  loader: ExtractorLoader,
): void {
  for (const ext of extensions) {
    loaders.set(normalizeExt(ext), loader);
  }
}

export async function getExtractor(ext: string): Promise<ContentExtractor> {
  const key = normalizeExt(ext);
  const loader = loaders.get(key);
  if (loader === undefined) {
    const supported = getSupportedExtensions();
    const suggestion =
      supported.length === 0
        ? "No extractors are currently registered."
        : `Supported extensions: ${supported.join(", ")}.`;
    throw new ExtractionError({
      kind: "unsupported-format",
      filePath: ext,
      message: `No extractor registered for extension "${ext}".`,
      suggestion,
    });
  }
  let pending = resolved.get(loader);
  if (pending === undefined) {
    // Evict the memoized promise if the loader rejects so a later lookup
    // retries the loader instead of re-serving a permanently poisoned
    // cache entry. Successful loads stay memoized (#924).
    pending = loader().catch((cause: unknown): never => {
      resolved.delete(loader);
      throw cause;
    });
    resolved.set(loader, pending);
  }
  return pending;
}

export function getSupportedExtensions(): readonly string[] {
  return Array.from(loaders.keys());
}

/**
 * Magic-byte format detection. Returns the canonical extension for
 * known signatures, or `null` when no match is found OR when the
 * signature is intentionally ambiguous (e.g. a ZIP container that
 * could be any OOXML/ODF format — the caller resolves via filename).
 */
export function detectFormatByMagicBytes(buffer: Buffer): string | null {
  if (buffer.length < 4) {
    return null;
  }
  if (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  ) {
    return ".pdf";
  }
  if (
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  ) {
    // ZIP container — ambiguous (docx/xlsx/pptx/odt/ods/odp). Caller
    // disambiguates using filename or deeper inspection.
    return null;
  }
  if (buffer.length >= 5) {
    if (
      buffer[0] === 0x7b &&
      buffer[1] === 0x5c &&
      buffer[2] === 0x72 &&
      buffer[3] === 0x74 &&
      buffer[4] === 0x66
    ) {
      return ".rtf";
    }
  }
  return null;
}
