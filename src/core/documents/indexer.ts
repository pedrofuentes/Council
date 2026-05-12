/**
 * Document content indexer (Roadmap 6.3).
 *
 * Writes extracted document text into the `document_index` FTS5 virtual
 * table (migration 007) so chat sessions can retrieve relevant snippets
 * for retrieval-augmented generation.
 *
 * The FTS5 table stores content alongside `source_type` (`'expert'` or
 * `'panel'`), `source_slug`, and `file_path`. Re-indexing the same path
 * replaces any existing entry, keeping the index in sync with on-disk
 * document state without requiring a separate "checksum changed" path.
 *
 * Implementation note: Kysely does not model FTS5 virtual tables in its
 * type system (they have special INSERT/DELETE semantics), so we drive
 * them with raw `sql` tagged templates.
 */
import { sql } from "kysely";

import type { CouncilDatabase } from "../../memory/db.js";

export type DocumentSourceType = "expert" | "panel";

export interface IndexDocumentOptions {
  readonly content: string;
  readonly sourceType: DocumentSourceType;
  readonly sourceSlug: string;
  readonly filePath: string;
}

export interface DocumentIndexer {
  /** Index a document's content. Replaces any existing entry for the same path. */
  index(options: IndexDocumentOptions): Promise<void>;
  /** Remove a document from the index by file path. No-op if absent. */
  remove(filePath: string): Promise<void>;
  /** Remove all indexed documents for a given source (`expert`/`panel`, slug). */
  removeAll(sourceType: DocumentSourceType, sourceSlug: string): Promise<void>;
}

export function createDocumentIndexer(db: CouncilDatabase): DocumentIndexer {
  return {
    async index(options: IndexDocumentOptions): Promise<void> {
      // Replace-by-path semantics: delete any prior row then insert fresh.
      // FTS5 tables don't support UPSERT, so this two-step is the canonical pattern.
      await sql`DELETE FROM document_index WHERE file_path = ${options.filePath}`.execute(db);
      await sql`
        INSERT INTO document_index (content, source_type, source_slug, file_path)
        VALUES (${options.content}, ${options.sourceType}, ${options.sourceSlug}, ${options.filePath})
      `.execute(db);
    },

    async remove(filePath: string): Promise<void> {
      await sql`DELETE FROM document_index WHERE file_path = ${filePath}`.execute(db);
    },

    async removeAll(sourceType: DocumentSourceType, sourceSlug: string): Promise<void> {
      await sql`
        DELETE FROM document_index
        WHERE source_type = ${sourceType} AND source_slug = ${sourceSlug}
      `.execute(db);
    },
  };
}
