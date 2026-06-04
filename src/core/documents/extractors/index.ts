/**
 * Barrel for the modular document extraction system (T2).
 *
 * Re-exports public types, the error taxonomy, and the registry API.
 * Subsequent format-specific extractor modules (markdown, html, pdf,
 * …) will be imported here for their side-effect registration; none
 * exist yet at this point in the roadmap.
 */
export type {
  ContentExtractor,
  DocumentMetadata,
  ExtractedContent,
  ExtractionContext,
  ExtractorLoader,
} from "./types.js";

export { ExtractionError } from "./errors.js";
export type { ExtractionErrorInit, ExtractionErrorKind } from "./errors.js";

export {
  detectFormatByMagicBytes,
  getExtractor,
  getSupportedExtensions,
  registerExtractor,
} from "./registry.js";
