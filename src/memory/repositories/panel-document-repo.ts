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
    const existing = await this.db
      .selectFrom("panel_documents")
      .select(["id"])
      .where("panel_name", "=", input.panelName)
      .where("file_path", "=", input.filePath)
      .executeTakeFirst();
    if (existing) {
      await this.db
        .updateTable("panel_documents")
        .set({
          source: input.source,
          filename: input.filename,
          checksum: input.checksum,
          size_bytes: input.sizeBytes,
          word_count: input.wordCount,
          status: "processed",
          processed_at: new Date().toISOString(),
        })
        .where("id", "=", existing.id)
        .execute();
      return;
    }
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
        created_at: new Date().toISOString(),
      })
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

  async listDocuments(panelName: string): Promise<readonly PanelDocument[]> {
    const rows = await this.db
      .selectFrom("panel_documents")
      .selectAll()
      .where("panel_name", "=", panelName)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(toDomain);
  }
}
