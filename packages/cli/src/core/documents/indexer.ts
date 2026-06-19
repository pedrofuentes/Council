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
import { chunkText } from "./chunking.js";

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
      // Replace-by-path semantics: delete any prior rows then insert fresh.
      // FTS5 tables don't support UPSERT, so the canonical pattern is
      // DELETE + INSERT. The pair MUST run as an atomic unit — without a
      // transaction, an INSERT failure after a successful DELETE would
      // silently lose the existing entry (#356).
      //
      // Content is split into sentence-aligned, size-bounded chunks (T01)
      // and stored as one FTS5 row per chunk (all sharing the same
      // file_path). This lets the retriever return a whole matched chunk
      // verbatim instead of a 64-token snippet() window that crops long
      // prose (PDF/DOCX) mid-sentence. Short documents (a small table from
      // XLSX/CSV/PPTX/ODT, a one-line note) yield a single chunk, preserving
      // the prior one-row-per-document behavior. Empty/whitespace-only
      // content yields no chunks, so the path is removed from the index.
      //
      // We issue raw BEGIN/COMMIT against the same libsql client
      // connection rather than using Kysely's `db.transaction()`. The
      // libsql sqlite3 client implements `client.transaction()` by
      // detaching the current connection and lazily opening a new one
      // for non-transactional calls, which breaks `:memory:` databases
      // (the new connection is a brand-new empty DB). Raw BEGIN/COMMIT
      // on the client keeps connection state intact.
      const chunks = chunkText(options.content);
      await sql`BEGIN`.execute(db);
      try {
        await sql`DELETE FROM document_index WHERE file_path = ${options.filePath}`.execute(db);
        for (const chunk of chunks) {
          await sql`
            INSERT INTO document_index (content, source_type, source_slug, file_path)
            VALUES (${chunk}, ${options.sourceType}, ${options.sourceSlug}, ${options.filePath})
          `.execute(db);
        }
        await sql`COMMIT`.execute(db);
      } catch (err) {
        try {
          await sql`ROLLBACK`.execute(db);
        } catch {
          /* ignore — original error is more informative */
        }
        throw err;
      }
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
