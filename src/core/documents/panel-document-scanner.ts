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
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { detectDocumentChanges, type DocumentFile } from "./detector.js";
import * as extractorModule from "./extractor.js";
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
  /** Number of previously-tracked documents pruned (file removed from disk). */
  readonly pruned: number;
  readonly foldersFailed: number;
  readonly managedFolderFailed: boolean;
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
  // Track which previously-known paths we observed on disk this scan.
  // Anything left over after iterating all folders has been deleted and
  // must be pruned from both `panel_documents` and `document_index` so
  // RAG retrieval cannot still surface stale content (issue #386).
  const seenPaths = new Set<string>();

  let indexed = 0;
  let unchanged = 0;
  let failed = 0;
  let pruned = 0;
  let foldersFailed = 0;
  let managedFolderFailed = false;

  // Track folders we successfully scanned (canonical paths). Pruning is
  // only safe under these — if a folder failed to scan, its tracked
  // documents must NOT be pruned (a transient failure shouldn't wipe
  // the index for content we know was there).
  const scannedFolders: string[] = [];

  for (const folder of folders) {
    // Canonicalize first so the confinement boundary is anchored at the
    // *real* directory (mirrors the expert DocumentProcessor; see
    // src/core/documents/processor.ts:resolveRealRoot). Reject symlinked
    // roots outright, and treat non-directories / missing paths as a
    // folder-level failure so the operator notices.
    let canonical: string;
    try {
      const lst = await fs.lstat(folder.path);
      if (lst.isSymbolicLink()) {
        throw new Error(
          `panel docs: folder ${folder.path} is a symlink; refusing to follow it for confinement safety`,
        );
      }
      canonical = await fs.realpath(folder.path);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      // Missing managed folder is a no-op for indexing (the docs dir
      // may not have been created yet), but it still counts as a
      // "successful empty scan" for prune purposes: any managed-source
      // docs we previously tracked are now legitimately gone and must
      // be pruned, otherwise stale FTS entries persist after a user
      // wipes their docs folder (Sentinel finding #1).
      if (folder.source === "managed" && code === "ENOENT") {
        scannedFolders.push(folder.path);
        continue;
      }
      foldersFailed += 1;
      if (folder.source === "managed") managedFolderFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      onProgress?.({
        filename: folder.path,
        source: folder.source,
        status: "folder-failed",
        error: msg,
      });
      continue;
    }

    let detection;
    try {
      detection = await detectDocumentChanges(canonical, known, supportedFormats, {
        confinementRoot: canonical,
        _rootIsCanonical: true,
      });
    } catch (err: unknown) {
      // A folder that disappears between link and scan should not bring
      // down the panel — but surface it via the result + progress so
      // callers (and end users) are not left wondering why nothing
      // appeared.
      foldersFailed += 1;
      if (folder.source === "managed") managedFolderFailed = true;
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
    for (const u of detection.unchangedFiles) seenPaths.add(u.path);
    scannedFolders.push(canonical);

    const targets: readonly DocumentFile[] = [
      ...detection.newFiles,
      ...detection.modifiedFiles,
    ];
    for (const file of targets) {
      seenPaths.add(file.path);
      try {
        // Pass `confinementRoot` so extractDocument re-validates that
        // the file resolves inside the panel's docs folder. Without
        // this, a TOCTOU race between detector and extractor — or a
        // file that detector accepted but whose symlink target was
        // swapped mid-scan — could read sensitive files outside the
        // boundary (issue #385). The expert-side processor passes
        // confinementRoot for the same reason.
        const extracted = await extractorModule.extractDocument(file.path, {
          confinementRoot: canonical,
          _rootIsCanonical: true,
        });
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

  // Prune documents that exist in the DB but no longer on disk. Only
  // prune when the path is under a folder we successfully scanned —
  // otherwise a transient folder-level failure (unmounted drive,
  // permission flap) would destroy index entries we'd want back next
  // scan. The FTS deletion MUST succeed before we mark the metadata
  // row `removed`: otherwise the row looks pruned while stale content
  // is still searchable, an inconsistent state with privacy risk
  // (Sentinel finding #2). (issue #386)
  for (const [trackedPath] of known) {
    if (seenPaths.has(trackedPath)) continue;
    const ownerScanned = scannedFolders.some((f) => isUnderFolder(trackedPath, f));
    if (!ownerScanned) continue;
    try {
      await indexer.remove(trackedPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onProgress?.({
        filename: path.basename(trackedPath),
        source: "managed",
        status: "failed",
        error: `prune (FTS remove) failed: ${msg}`,
      });
      continue;
    }
    await docsRepo.markRemoved(panelName, trackedPath);
    pruned += 1;
  }

  return { indexed, unchanged, failed, pruned, foldersFailed, managedFolderFailed };
}

function isUnderFolder(filePath: string, folderPath: string): boolean {
  if (filePath === folderPath) return true;
  return (
    filePath.startsWith(folderPath + "/") || filePath.startsWith(folderPath + "\\")
  );
}

/**
 * Build a user-facing warning when *every* discovered document failed
 * to process. The scanner cannot tell the chat renderer to print
 * anything itself, so callers (chat startup, future `docs scan`) format
 * the result via this helper. Returns null when at least one document
 * indexed/remained unchanged, or when nothing failed (issue #389).
 */
export function formatAllFailedWarning(result: PanelScanResult): string | null {
  if (result.failed === 0) return null;
  if (result.indexed > 0 || result.unchanged > 0) return null;
  return `⚠ All ${result.failed} documents failed to process. Check file formats and permissions.`;
}
