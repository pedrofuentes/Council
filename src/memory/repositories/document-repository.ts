/**
 * Document repository — typed CRUD over the expert_documents table
 * (migration 006). Follows the snake_case-row → camelCase-domain pattern
 * established by expert-library-repo.ts and panel-library-repo.ts.
 */
import { sql } from "kysely";
import { ulid } from "ulid";

import type { CouncilDatabase, ExpertDocumentRow } from "../db.js";

export type DocumentStatus = "pending" | "processed" | "failed" | "removed";

/**
 * Thrown by {@link DocumentRepository.clearForRetrain} when the
 * transaction aborts. Exposes whether ROLLBACK itself succeeded so
 * call sites can produce honest user-facing messages (#425): if
 * {@link rollbackFailed} is `true`, the database state may be
 * inconsistent and the message MUST NOT claim that data was preserved.
 */
export class ClearForRetrainError extends Error {
  readonly rollbackFailed: boolean;
  readonly rollbackError?: unknown;

  constructor(
    message: string,
    opts: { cause: unknown; rollbackFailed: boolean; rollbackError?: unknown },
  ) {
    super(message, { cause: opts.cause });
    this.name = "ClearForRetrainError";
    this.rollbackFailed = opts.rollbackFailed;
    if (opts.rollbackError !== undefined) {
      this.rollbackError = opts.rollbackError;
    }
  }
}

export interface ExpertDocument {
  readonly id: string;
  readonly expertSlug: string;
  readonly filePath: string;
  readonly filename: string;
  readonly checksum: string;
  readonly sizeBytes: number;
  readonly wordCount: number;
  readonly status: DocumentStatus;
  readonly processedAt: string | null;
  readonly createdAt: string;
}

export interface NewExpertDocument {
  readonly expertSlug: string;
  readonly filePath: string;
  readonly filename: string;
  readonly checksum: string;
  readonly sizeBytes: number;
  readonly wordCount: number;
}

function toDomain(row: ExpertDocumentRow): ExpertDocument {
  return {
    id: row.id,
    expertSlug: row.expert_slug,
    filePath: row.file_path,
    filename: row.filename,
    checksum: row.checksum,
    sizeBytes: row.size_bytes,
    wordCount: row.word_count,
    status: row.status as DocumentStatus,
    processedAt: row.processed_at,
    createdAt: row.created_at,
  };
}

export class DocumentRepository {
  constructor(private readonly db: CouncilDatabase) {}

  async create(input: NewExpertDocument): Promise<ExpertDocument> {
    const id = ulid();
    const now = new Date().toISOString();
    await this.db
      .insertInto("expert_documents")
      .values({
        id,
        expert_slug: input.expertSlug,
        file_path: input.filePath,
        filename: input.filename,
        checksum: input.checksum,
        size_bytes: input.sizeBytes,
        word_count: input.wordCount,
        status: "pending",
        processed_at: null,
        created_at: now,
      })
      .execute();
    const row = await this.db
      .selectFrom("expert_documents")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return toDomain(row);
  }

  async findByExpert(slug: string): Promise<readonly ExpertDocument[]> {
    const rows = await this.db
      .selectFrom("expert_documents")
      .selectAll()
      .where("expert_slug", "=", slug)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(toDomain);
  }

  async findByPath(expertSlug: string, filePath: string): Promise<ExpertDocument | undefined> {
    const row = await this.db
      .selectFrom("expert_documents")
      .selectAll()
      .where("expert_slug", "=", expertSlug)
      .where("file_path", "=", filePath)
      .executeTakeFirst();
    return row ? toDomain(row) : undefined;
  }

  async updateStatus(id: string, status: string, processedAt?: string): Promise<void> {
    const updates: Record<string, unknown> = { status };
    if (processedAt !== undefined) updates["processed_at"] = processedAt;
    await this.db.updateTable("expert_documents").set(updates).where("id", "=", id).execute();
  }

  async updateChecksum(
    id: string,
    checksum: string,
    sizeBytes: number,
    wordCount: number,
  ): Promise<void> {
    await this.db
      .updateTable("expert_documents")
      .set({ checksum, size_bytes: sizeBytes, word_count: wordCount })
      .where("id", "=", id)
      .execute();
  }

  async getChecksumMap(expertSlug: string): Promise<ReadonlyMap<string, string>> {
    const rows = await this.db
      .selectFrom("expert_documents")
      .select(["file_path", "checksum"])
      .where("expert_slug", "=", expertSlug)
      .where("status", "!=", "removed")
      .execute();
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.file_path, r.checksum);
    return map;
  }

  async markRemoved(id: string): Promise<void> {
    await this.db
      .updateTable("expert_documents")
      .set({ status: "removed" })
      .where("id", "=", id)
      .execute();
  }

  async markAllRemovedByExpert(expertSlug: string): Promise<void> {
    // Single bulk UPDATE replaces a per-row loop (#383) so the retrain
    // clear path is atomic: either every active row flips to "removed"
    // or none does (SQLite per-statement transaction).
    await this.db
      .updateTable("expert_documents")
      .set({ status: "removed" })
      .where("expert_slug", "=", expertSlug)
      .where("status", "!=", "removed")
      .execute();
  }

  /**
   * Atomically clear an expert's FTS index entries AND mark all of its
   * tracked documents as removed (#383). The two writes are a single
   * unit: if the FTS rows are deleted but the tracking UPDATE fails (or
   * vice versa) retrieval can silently return stale or missing results.
   *
   * Implemented with raw ``BEGIN``/``COMMIT``/``ROLLBACK`` on the libsql
   * client (same workaround as ``indexer.ts``: Kysely's ``transaction()``
   * helper reconnects the libsql ``:memory:`` connection, which loses
   * virtual FTS5 tables).
   *
   * On failure, throws {@link ClearForRetrainError}. Callers MUST inspect
   * ``rollbackFailed`` (#425): when the rollback itself failed the DB
   * may be in an inconsistent state and the user-facing message must NOT
   * claim that prior data was preserved.
   */
  async clearForRetrain(expertSlug: string): Promise<void> {
    try {
      await sql`BEGIN`.execute(this.db);
    } catch (beginErr) {
      // Transaction never opened, so no rollback is needed and no DB
      // mutation occurred. Still wrap the error in ClearForRetrainError
      // so callers always see the same failure contract (#425): they
      // can trust `rollbackFailed === false` here means the prior state
      // is intact.
      const detail = beginErr instanceof Error ? beginErr.message : String(beginErr);
      throw new ClearForRetrainError(
        `clearForRetrain failed for "${expertSlug}" before any changes ` +
          `(BEGIN failed; no changes applied): ${detail}`,
        { cause: beginErr, rollbackFailed: false },
      );
    }
    let committed = false;
    try {
      await sql`DELETE FROM document_index WHERE source_type = 'expert' AND source_slug = ${expertSlug}`.execute(
        this.db,
      );
      await sql`UPDATE expert_documents SET status = 'removed' WHERE expert_slug = ${expertSlug} AND status != 'removed'`.execute(
        this.db,
      );
      await sql`COMMIT`.execute(this.db);
      committed = true;
    } catch (err) {
      if (committed) {
        // Defensive: transaction already committed successfully, so any
        // error here is from hypothetical post-COMMIT work. Do NOT issue
        // ROLLBACK (transaction is closed) — just rethrow with a message
        // that acknowledges the COMMIT succeeded (#537).
        const detail = err instanceof Error ? err.message : String(err);
        throw new ClearForRetrainError(
          `clearForRetrain committed successfully for "${expertSlug}" but a subsequent ` +
            `operation failed: ${detail}`,
          { cause: err, rollbackFailed: false },
        );
      }
      let rollbackFailed = false;
      let rollbackError: unknown;
      try {
        await sql`ROLLBACK`.execute(this.db);
      } catch (rbErr) {
        rollbackFailed = true;
        rollbackError = rbErr;
      }
      const detail = err instanceof Error ? err.message : String(err);
      const message = rollbackFailed
        ? `clearForRetrain failed for "${expertSlug}" and ROLLBACK also failed; ` +
          `database may be in an inconsistent state (FTS index and document tracking ` +
          `may disagree): ${detail}`
        : `clearForRetrain failed for "${expertSlug}" (transaction rolled back cleanly): ${detail}`;
      throw new ClearForRetrainError(
        message,
        rollbackError === undefined
          ? { cause: err, rollbackFailed }
          : { cause: err, rollbackFailed, rollbackError },
      );
    }
  }
}
