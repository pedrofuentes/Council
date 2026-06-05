/**
 * Typed error taxonomy for the document extraction system (T2). All
 * extractor failures should be reported as an `ExtractionError` so that
 * higher layers (indexer, retriever, UI) can branch on `kind` without
 * relying on message-string parsing.
 */

export type ExtractionErrorKind =
  | "unsupported-format"
  | "encrypted-document"
  | "corrupt-document"
  | "oversize-file"
  | "extraction-timeout"
  | "zip-bomb-detected"
  | "ai-extraction-declined"
  | "ai-extraction-failed";

export interface ExtractionErrorInit {
  readonly kind: ExtractionErrorKind;
  readonly filePath: string;
  readonly message: string;
  readonly suggestion?: string;
  readonly cause?: unknown;
}

export class ExtractionError extends Error {
  public readonly kind: ExtractionErrorKind;
  public readonly filePath: string;
  public readonly suggestion?: string;

  public constructor(init: ExtractionErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ExtractionError";
    this.kind = init.kind;
    this.filePath = init.filePath;
    if (init.suggestion !== undefined) {
      this.suggestion = init.suggestion;
    }
  }
}
