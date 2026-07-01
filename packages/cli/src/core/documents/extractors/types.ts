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
  /**
   * True when this content was produced by the AI fallback
   * (`attemptAiFallback`) rather than a native extractor. Consumers MUST
   * treat AI-fallback content as lower fidelity than a native parse and
   * MUST NOT conflate the two. Native extractions leave this unset.
   */
  readonly aiFallback?: boolean;
  /**
   * AI fallback: friendly description of the detected format (extension
   * plus a magic-byte signature hint). Carried through from
   * `AiFallbackMetadata.detectedFormat`.
   */
  readonly detectedFormat?: string;
  /**
   * AI fallback: human-readable next-step suggestion for the user (e.g.
   * "convert to a natively supported format"). Carried through from
   * `AiFallbackMetadata.suggestedAction`.
   */
  readonly suggestedAction?: string;
  /**
   * AI fallback (`ask` mode): when true the caller MUST obtain explicit
   * user confirmation before treating this content as a real extraction.
   * This flag is what makes an ask-mode result a distinct
   * "review-required" outcome rather than ordinary indexable content.
   */
  readonly askUser?: boolean;
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
 * Lazy factory thunk returning a `ContentExtractor`. The registry
 * invokes a loader at most once per loader instance for a given
 * successful resolution, and the resulting extractor is memoized.
 * A rejected load is evicted from the cache so a later lookup
 * re-invokes the loader — loaders MUST tolerate being called more
 * than once.
 */
export type ExtractorLoader = () => Promise<ContentExtractor>;
