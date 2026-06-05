/**
 * Barrel for the modular document extraction system.
 *
 * Re-exports public types, the error taxonomy, and the registry API.
 * Side-effect imports below trigger each format-specific extractor
 * module to self-register with the registry on first import of this
 * barrel — `extractor.ts` and any other consumer that imports this
 * file will see the built-in extractors (markdown, html, plaintext)
 * already present.
 */
import "./markdown.js";
import "./html.js";
import "./plaintext.js";
import "./pdf.js";
import "./csv.js";
import "./rtf.js";
import "./docx.js";
import "./pptx.js";

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
