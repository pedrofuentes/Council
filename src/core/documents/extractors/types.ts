/**
 * Public type definitions for the modular document extraction system
 * (T2). Each format-specific extractor module conforms to
 * `ContentExtractor` and is registered with the registry via an
 * `ExtractorLoader` thunk so that heavy dependencies are loaded lazily.
 */

export interface DocumentMetadata {
  readonly title?: string;
  readonly author?: string;
  /** Page count — populated by PDF extractors. */
  readonly pageCount?: number;
  /** Sheet names — populated by XLSX/ODS extractors. */
  readonly sheetNames?: readonly string[];
  /** Slide count — populated by PPTX/ODP extractors. */
  readonly slideCount?: number;
}

export interface ExtractionContext {
  readonly buffer: Buffer;
  readonly filename: string;
  /** Pre-parsed file extension, lowercase, including dot (e.g. ".pdf"). */
  readonly extension: string;
  readonly sizeBytes: number;
  /** Cooperative cancellation for extraction timeouts. */
  readonly signal?: AbortSignal;
}

export interface ExtractedContent {
  readonly content: string;
  readonly wordCount: number;
  readonly metadata?: DocumentMetadata;
}

export type ContentExtractor = (
  ctx: ExtractionContext,
) => Promise<ExtractedContent>;

/**
 * Lazy factory thunk returning a `ContentExtractor`. Loaders are invoked
 * at most once per extension by the registry and the resulting extractor
 * is memoized.
 */
export type ExtractorLoader = () => Promise<ContentExtractor>;
