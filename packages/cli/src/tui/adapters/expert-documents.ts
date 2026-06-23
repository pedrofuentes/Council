import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type {
  DocumentStatus,
  ExpertDocument,
} from "../../memory/repositories/document-repository.js";

export interface ExpertDocumentView {
  readonly id: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly wordCount: number;
  readonly status: DocumentStatus;
  readonly processedAt: string | null;
}

export interface ExpertDocumentsDataSource {
  list(slug: string): Promise<readonly ExpertDocumentView[]>;
  remove(slug: string, id: string): Promise<{ readonly ftsCleanupFailed: boolean }>;
}

export interface ExpertDocumentsDeps {
  readonly repo: {
    findByExpert(slug: string): Promise<readonly ExpertDocument[]>;
    markRemoved(id: string): Promise<void>;
  };
  readonly indexer: { remove(filePath: string): Promise<void> };
}

function toView(document: ExpertDocument): ExpertDocumentView {
  return {
    id: document.id,
    filename: toSingleLineDisplay(document.filename),
    sizeBytes: document.sizeBytes,
    wordCount: document.wordCount,
    status: document.status,
    processedAt: document.processedAt,
  };
}

export function createExpertDocumentsSource(deps: ExpertDocumentsDeps): ExpertDocumentsDataSource {
  return {
    list: async (slug: string): Promise<readonly ExpertDocumentView[]> => {
      const documents = await deps.repo.findByExpert(slug);
      return documents.filter((document) => document.status !== "removed").map(toView);
    },
    remove: async (slug: string, id: string): Promise<{ readonly ftsCleanupFailed: boolean }> => {
      const documents = await deps.repo.findByExpert(slug);
      const document = documents.find((row) => row.id === id && row.status !== "removed");
      if (document === undefined) {
        throw new Error(
          `Document "${toSingleLineDisplay(id)}" not found for expert "${toSingleLineDisplay(
            slug,
          )}".`,
        );
      }

      // Mark removed before FTS cleanup so a later training run can heal any
      // cleanup failure by re-indexing the file via replace-by-path.
      await deps.repo.markRemoved(id);
      try {
        await deps.indexer.remove(document.filePath);
        return { ftsCleanupFailed: false };
      } catch {
        return { ftsCleanupFailed: true };
      }
    },
  };
}
