/**
 * Panel document repository — typed CRUD over the `panel_linked_folders`
 * and `panel_documents` tables (migration 009). Mirrors the pattern in
 * `document-repository.ts` (expert-scoped) with two surface-level
 * differences:
 *
 *   - `addLinkedFolder` is idempotent on (panel_name, folder_path) so
 *     callers can re-link without checking existence first.
 *   - `trackDocument` upserts on (panel_name, file_path), refreshing
 *     checksum/size/word-count/status when the row already exists. The
 *     panel doc scanner is the only writer and it always wants
 *     latest-wins semantics; exposing a separate `updateChecksum` would
 *     just push that branching to every caller.
 */
import { ulid } from "ulid";

import type { CouncilDatabase, PanelDocumentRow } from "../db.js";

export type PanelDocumentSource = "managed" | "linked";
export type PanelDocumentStatus = "pending" | "processed" | "failed" | "removed";

export interface PanelDocument {
  readonly id: string;
  readonly panelName: string;
  readonly source: PanelDocumentSource;
  readonly filePath: string;
  readonly filename: string;
  readonly checksum: string;
  readonly sizeBytes: number;
  readonly wordCount: number;
  readonly status: PanelDocumentStatus;
  readonly processedAt: string | null;
  readonly createdAt: string;
}

export interface NewPanelDocument {
  readonly panelName: string;
  readonly source: PanelDocumentSource;
  readonly filePath: string;
  readonly filename: string;
  readonly checksum: string;
  readonly sizeBytes: number;
  readonly wordCount: number;
}

function toDomain(row: PanelDocumentRow): PanelDocument {
  return {
    id: row.id,
    panelName: row.panel_name,
    source: row.source as PanelDocumentSource,
    filePath: row.file_path,
    filename: row.filename,
    checksum: row.checksum,
    sizeBytes: row.size_bytes,
    wordCount: row.word_count,
    status: row.status as PanelDocumentStatus,
    processedAt: row.processed_at,
    createdAt: row.created_at,
  };
}

export class PanelDocumentRepository {
  constructor(private readonly db: CouncilDatabase) {}

  async addLinkedFolder(panelName: string, folderPath: string): Promise<void> {
    const existing = await this.db
      .selectFrom("panel_linked_folders")
      .select("id")
      .where("panel_name", "=", panelName)
      .where("folder_path", "=", folderPath)
      .executeTakeFirst();
    if (existing) return;
    await this.db
      .insertInto("panel_linked_folders")
      .values({
        id: ulid(),
        panel_name: panelName,
        folder_path: folderPath,
        created_at: new Date().toISOString(),
      })
      .execute();
  }

  async removeLinkedFolder(panelName: string, folderPath: string): Promise<void> {
    await this.db
      .deleteFrom("panel_linked_folders")
      .where("panel_name", "=", panelName)
      .where("folder_path", "=", folderPath)
      .execute();
  }

  async getLinkedFolders(panelName: string): Promise<readonly string[]> {
    const rows = await this.db
      .selectFrom("panel_linked_folders")
      .select("folder_path")
      .where("panel_name", "=", panelName)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map((r) => r.folder_path);
  }

  async trackDocument(input: NewPanelDocument): Promise<void> {
    // Atomic upsert via ON CONFLICT on the (panel_name, file_path) UNIQUE
    // constraint — eliminates the SELECT-then-INSERT race where two
    // concurrent scans could both miss and both attempt INSERT (#387).
    const nowIso = new Date().toISOString();
    await this.db
      .insertInto("panel_documents")
      .values({
        id: ulid(),
        panel_name: input.panelName,
        source: input.source,
        file_path: input.filePath,
        filename: input.filename,
        checksum: input.checksum,
        size_bytes: input.sizeBytes,
        word_count: input.wordCount,
        status: "pending",
        processed_at: null,
        created_at: nowIso,
      })
      .onConflict((oc) =>
        oc.columns(["panel_name", "file_path"]).doUpdateSet({
          source: input.source,
          filename: input.filename,
          checksum: input.checksum,
          size_bytes: input.sizeBytes,
          word_count: input.wordCount,
          status: "processed",
          processed_at: nowIso,
        }),
      )
      .execute();
  }

  async getChecksumMap(panelName: string): Promise<ReadonlyMap<string, string>> {
    const rows = await this.db
      .selectFrom("panel_documents")
      .select(["file_path", "checksum"])
      .where("panel_name", "=", panelName)
      .where("status", "!=", "removed")
      .execute();
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.file_path, r.checksum);
    return map;
  }

  async getWordCountMap(panelName: string): Promise<ReadonlyMap<string, number>> {
    const rows = await this.db
      .selectFrom("panel_documents")
      .select(["file_path", "word_count"])
      .where("panel_name", "=", panelName)
      .where("status", "!=", "removed")
      .execute();
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.file_path, r.word_count);
    return map;
  }

  async listDocuments(panelName: string): Promise<readonly PanelDocument[]> {
    const rows = await this.db
      .selectFrom("panel_documents")
      .selectAll()
      .where("panel_name", "=", panelName)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(toDomain);
  }

  /**
   * Mark a single tracked document as `removed` — used by the scanner
   * when a previously-indexed file has disappeared from disk. The row
   * stays for audit; future scans see no checksum for that path (the
   * `getChecksumMap` query filters out `removed`) and will re-index if
   * the file reappears.
   */
  async markRemoved(panelName: string, filePath: string): Promise<void> {
    await this.db
      .updateTable("panel_documents")
      .set({ status: "removed", processed_at: new Date().toISOString() })
      .where("panel_name", "=", panelName)
      .where("file_path", "=", filePath)
      .execute();
  }

  async removeDocumentsUnderFolder(
    panelName: string,
    folderPath: string,
  ): Promise<void> {
    // Match the folder itself plus any descendant whose path starts with
    // `folderPath` followed by either OS separator. We test both `/` and
    // `\` rather than relying on `path.sep` because stored paths may
    // originate from cross-platform sources (e.g. Windows + WSL).
    //
    // We filter in application code rather than via SQL LIKE so that
    // folder names containing `%` or `_` (rare but valid on POSIX) do
    // not over-match. The result-set is bounded by the panel scope.
    const rows = await this.db
      .selectFrom("panel_documents")
      .select(["id", "file_path"])
      .where("panel_name", "=", panelName)
      .execute();
    const ids = rows
      .filter(
        (r) =>
          r.file_path === folderPath ||
          r.file_path.startsWith(folderPath + "/") ||
          r.file_path.startsWith(folderPath + "\\"),
      )
      .map((r) => r.id);
    if (ids.length === 0) return;
    await this.db.deleteFrom("panel_documents").where("id", "in", ids).execute();
  }
}
