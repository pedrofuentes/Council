/**
 * Panel document scanner (Roadmap 6.7).
 *
 * Walks a panel's managed docs folder and every linked external folder,
 * detects new/modified files via SHA-256 checksum comparison against
 * `panel_documents`, and indexes their normalized content into the
 * existing FTS5 `document_index` table under `source_type = 'panel'`.
 *
 * Designed to be called on panel chat startup so the RAG corpus reflects
 * the latest on-disk state without requiring a separate "rebuild" step.
 * Per-file failures are isolated — a single broken file does not block
 * the chat from launching.
 *
 * Unlike the expert-side `DocumentProcessor`, panels do not run a
 * persona-profile analyzer pass: panel documents are shared reference
 * material, not biographical input.
 */
import * as path from "node:path";

import { detectDocumentChanges, type DocumentFile } from "./detector.js";
import { extractDocument } from "./extractor.js";
import { createDocumentIndexer } from "./indexer.js";
import type { CouncilDatabase } from "../../memory/db.js";
import {
  PanelDocumentRepository,
  type PanelDocumentSource,
} from "../../memory/repositories/panel-document-repo.js";

export interface ScanPanelDocumentsOptions {
  readonly panelName: string;
  readonly managedDocsDir: string;
  readonly db: CouncilDatabase;
  readonly supportedFormats: readonly string[];
  /** Optional progress callback — invoked once per file outcome. */
  readonly onProgress?: (event: PanelScanProgress) => void;
}

export interface PanelScanProgress {
  readonly filename: string;
  readonly source: PanelDocumentSource;
  readonly status: "indexed" | "unchanged" | "failed" | "folder-failed";
  readonly error?: string;
}

export interface PanelScanResult {
  readonly indexed: number;
  readonly unchanged: number;
  readonly failed: number;
  readonly foldersFailed: number;
}

interface FolderToScan {
  readonly source: PanelDocumentSource;
  readonly path: string;
}

export async function scanAndIndexPanelDocuments(
  options: ScanPanelDocumentsOptions,
): Promise<PanelScanResult> {
  const { panelName, managedDocsDir, db, supportedFormats, onProgress } = options;
  const docsRepo = new PanelDocumentRepository(db);
  const indexer = createDocumentIndexer(db);

  const linkedFolders = await docsRepo.getLinkedFolders(panelName);
  const folders: FolderToScan[] = [
    { source: "managed", path: managedDocsDir },
    ...linkedFolders.map((p) => ({ source: "linked" as const, path: p })),
  ];

  const known = await docsRepo.getChecksumMap(panelName);

  let indexed = 0;
  let unchanged = 0;
  let failed = 0;
  let foldersFailed = 0;

  for (const folder of folders) {
    let detection;
    try {
      detection = await detectDocumentChanges(folder.path, known, supportedFormats);
    } catch (err: unknown) {
      // A folder that disappears between link and scan should not bring
      // down the panel — but surface it via the result + progress so
      // callers (and end users) are not left wondering why nothing
      // appeared.
      foldersFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      onProgress?.({
        filename: folder.path,
        source: folder.source,
        status: "folder-failed",
        error: msg,
      });
      continue;
    }

    unchanged += detection.unchangedFiles.length;

    const targets: readonly DocumentFile[] = [
      ...detection.newFiles,
      ...detection.modifiedFiles,
    ];
    for (const file of targets) {
      try {
        const extracted = await extractDocument(file.path);
        await indexer.index({
          content: extracted.content,
          sourceType: "panel",
          sourceSlug: panelName,
          filePath: file.path,
        });
        await docsRepo.trackDocument({
          panelName,
          source: folder.source,
          filePath: file.path,
          filename: file.filename,
          checksum: extracted.checksum,
          sizeBytes: extracted.sizeBytes,
          wordCount: extracted.wordCount,
        });
        indexed += 1;
        onProgress?.({ filename: file.filename, source: folder.source, status: "indexed" });
      } catch (err: unknown) {
        failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        onProgress?.({
          filename: file.filename,
          source: folder.source,
          status: "failed",
          error: msg,
        });
      }
    }

    for (const u of detection.unchangedFiles) {
      onProgress?.({
        filename: path.basename(u.path),
        source: folder.source,
        status: "unchanged",
      });
    }
  }

  return { indexed, unchanged, failed, foldersFailed };
}
