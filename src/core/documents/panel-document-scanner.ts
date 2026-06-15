/**
 * Panel document scanner (Roadmap 6.7).
 *
 * Walks a panel's managed docs folder and every linked external folder,
 * detects new/modified files via SHA-256 checksum comparison against
 * `panel_documents`, and indexes their normalized content into the
 * existing FTS5 `document_index` table under `source_type = 'panel'`.
 *
 * **Reconciliation scope is narrow and conditional.** A tracked file is
 * pruned (its `panel_documents` row marked `removed` AND its
 * `document_index` entry deleted) only when (a) the folder it lives in
 * was scanned successfully on this invocation AND (b) the detector
 * neither saw it on disk nor reported it as a "transient unknown
 * state" (e.g. an lstat that failed without confirming a hard rejection
 * — see issue #342). A folder-level scan failure (missing path,
 * permission error, unreadable directory) skips pruning for every file
 * tracked under that folder, so a transient mount problem cannot wipe
 * the index. Hard confinement / TOCTOU rejections from the detector
 * are NOT preserved across reconciliation — those entries become
 * eligible for pruning so the scanner can drop content whose on-disk
 * file is now invalid.
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

import type { Stats } from "node:fs";

import { sql } from "kysely";

import { detectDocumentChanges, type DocumentFile } from "./detector.js";
import * as extractorModule from "./extractor.js";
import type { AiFallbackOption } from "./extractor.js";
import { createDocumentIndexer } from "./indexer.js";
import {
  classifyExtractionError,
  classifyUnsupportedFile,
  type ScanFileDetail,
} from "./scan-types.js";
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
  /**
   * Optional ceiling (in bytes) forwarded to `extractDocument` as
   * `maxFileSizeBytes`. When omitted the extractor falls back to its
   * built-in 50 MiB default. Callers derive this from
   * `config.documents.maxFileSizeMB * 1024 * 1024`.
   */
  readonly maxFileSizeBytes?: number;
  /**
   * Opt-in AI fallback forwarded verbatim to `extractDocument`. Built
   * from `documents.aiExtraction` (mode) +
   * `documents.aiExtractionAllowedExtensions`. When omitted or
   * `mode: "off"`, unsupported formats fail exactly as before. `auto`
   * indexes AI-extracted content (flagged `aiExtracted`); `ask` holds the
   * file as needs-review without indexing.
   */
  readonly aiFallback?: AiFallbackOption;
  /** Optional progress callback — invoked once per file outcome. */
  readonly onProgress?: (event: PanelScanProgress) => void;
  /** Optional warning sink for per-file recoverable errors (#448). */
  readonly onWarning?: (message: string) => void;
  /**
   * Test-only seam: forwarded to the underlying detector as
   * `_lstatOverride`. Lets reconciliation tests inject per-file
   * lstat failures without monkey-patching the `node:fs/promises`
   * ESM namespace (which is non-configurable on V8).
   */
  readonly _detectorLstatOverride?: (path: string) => Promise<Stats>;
}

export interface PanelScanProgress {
  readonly filename: string;
  readonly source: PanelDocumentSource;
  readonly status: "indexed" | "unchanged" | "failed" | "folder-failed" | "needs-review";
  readonly error?: string;
}

export interface PanelScanResult {
  readonly indexed: number;
  readonly unchanged: number;
  readonly failed: number;
  /**
   * Count of files held for manual review (AI fallback `ask` mode):
   * detected as AI-extractable but NOT indexed into FTS and NOT tracked,
   * pending explicit user approval. Surfaced by scan UX as needs-review.
   */
  readonly needsReview: number;
  /**
   * Count of files dropped because their extension is not in
   * `supportedFormats` (e.g. `.png`, `.zip`). The detector filters these
   * out before extraction; the scanner surfaces them as a distinct
   * outcome instead of dropping them silently. Also counted in `failed`
   * (and present in `files` as `status: "failed"` /
   * `errorKind: "unsupported-format"`) so the chat-startup render gate
   * fires and `docs review` / `docs doctor` can enumerate them.
   */
  readonly unsupported: number;
  /** Number of previously-tracked documents pruned (file removed from disk). */
  readonly pruned: number;
  readonly foldersFailed: number;
  readonly managedFolderFailed: boolean;
  /**
   * Per-file scan details (Task T12). Populated for every file the
   * scanner saw — indexed, unchanged, failed, or rejected by
   * confinement. Consumers (e.g. `formatScanSummary`) use this to
   * render rich, actionable feedback. The aggregate counts above are
   * preserved for backward compatibility.
   */
  readonly files: readonly ScanFileDetail[];
}

interface FolderToScan {
  readonly source: PanelDocumentSource;
  readonly path: string;
}

export async function scanAndIndexPanelDocuments(
  options: ScanPanelDocumentsOptions,
): Promise<PanelScanResult> {
  const { panelName, managedDocsDir, db, supportedFormats, onProgress, onWarning } = options;
  const maxFileSizeBytes = options.maxFileSizeBytes;
  const aiFallback = options.aiFallback;
  const docsRepo = new PanelDocumentRepository(db);
  const indexer = createDocumentIndexer(db);

  const linkedFolders = await docsRepo.getLinkedFolders(panelName);
  const folders: FolderToScan[] = [
    { source: "managed", path: managedDocsDir },
    ...linkedFolders.map((p) => ({ source: "linked" as const, path: p })),
  ];

  const known = await docsRepo.getChecksumMap(panelName);
  const wordCounts = await docsRepo.getWordCountMap(panelName);
  // Track which previously-known paths we observed on disk this scan.
  // Anything left over after iterating all folders has been deleted and
  // must be pruned from both `panel_documents` and `document_index` so
  // RAG retrieval cannot still surface stale content (issue #386).
  const seenPaths = new Set<string>();

  let indexed = 0;
  let unchanged = 0;
  let failed = 0;
  let needsReview = 0;
  let unsupported = 0;
  let pruned = 0;
  let foldersFailed = 0;
  let managedFolderFailed = false;
  const files: ScanFileDetail[] = [];

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
      //
      // Tracked file paths were stored relative to the canonical
      // root from a previous successful scan (e.g. /private/tmp/...
      // on macOS where /tmp is a symlink to /private/tmp). The raw
      // `folder.path` may differ. Resolve the closest existing
      // ancestor via realpath and re-attach the missing tail so the
      // prune prefix matches stored paths even through symlinked
      // ancestors. We push BOTH variants (raw + resolved) to remain
      // safe if a previous scan happened to store the non-canonical
      // form.
      if (folder.source === "managed" && code === "ENOENT") {
        scannedFolders.push(folder.path);
        try {
          const canonical = await resolveMissingPath(folder.path);
          if (canonical !== folder.path) scannedFolders.push(canonical);
        } catch {
          /* best-effort — raw path is still tried */
        }
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
        ...(onWarning ? { onWarning } : {}),
        ...(options._detectorLstatOverride
          ? { _lstatOverride: options._detectorLstatOverride }
          : {}),
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
    for (const u of detection.unchangedFiles) {
      seenPaths.add(u.path);
      const wordCount = wordCounts.get(u.path);
      files.push({
        path: u.path,
        filename: path.basename(u.path),
        extension: path.extname(u.path).toLowerCase(),
        status: "unchanged",
        ...(wordCount !== undefined ? { wordCount } : {}),
      });
    }
    // Transient per-file detector failures (lstat/read errors that did
    // NOT confirm a hard rejection — #342) must be preserved across
    // deletion reconciliation: a tracked file that the detector
    // temporarily couldn't stat is NOT "deleted on disk" and pruning it
    // would silently destroy persisted FTS / panel_documents state.
    for (const unknown of detection.unknownStateFiles) seenPaths.add(unknown);
    // HARD `rejectedFiles` (confinement violations / TOCTOU) are added
    // to seenPaths to match DocumentProcessor behavior (#447): rejected
    // files suppress pruning so a file whose confinement status changed
    // doesn't get its persisted state deleted automatically.
    for (const rejected of detection.rejectedFiles) {
      seenPaths.add(rejected);
      // Surface confinement rejections as failed entries in the file
      // detail list so operators can see them in the scan summary
      // (Task T12). These are intentionally NOT counted in `failed` —
      // the existing aggregate semantics treat rejected files as
      // skipped-but-tracked, not as processing failures.
      files.push({
        path: rejected,
        filename: path.basename(rejected),
        extension: path.extname(rejected).toLowerCase(),
        status: "failed",
        errorKind: "confinement-violation",
        errorMessage: "rejected: outside confinement root or TOCTOU mismatch",
      });
    }
    // Unsupported-extension files (e.g. `.png`, `.zip`) are filtered by
    // the detector before extraction. Historically dropped silently;
    // surface them as a distinct `unsupported` outcome and count them in
    // `failed` too — the chat-startup render gate only fires on
    // indexed/unchanged/failed/needsReview, so an unsupported-only scan
    // must register here to be reported. `seenPaths` keeps them out of
    // the prune pass.
    //
    // When `aiExtraction` is `ask`, an eligible (non-blocklisted,
    // allowlisted) extension is held as a `needs-review` outcome instead
    // (`classifyUnsupportedFile`): `ask` means review, so it surfaces as
    // "awaiting AI-extraction review" — NOT indexed, NOT tracked, NOT a
    // failure. No extraction is performed; the file is only flagged. The
    // needs-review count still fires the render gate above.
    for (const unsupportedPath of detection.unsupportedFiles) {
      seenPaths.add(unsupportedPath);
      const detail = classifyUnsupportedFile(unsupportedPath, aiFallback);
      if (detail.status === "needs-review") {
        needsReview += 1;
        onProgress?.({
          filename: detail.filename,
          source: folder.source,
          status: "needs-review",
        });
      } else {
        failed += 1;
        unsupported += 1;
      }
      files.push(detail);
    }
    scannedFolders.push(canonical);

    const newSet = new Set(detection.newFiles.map((f) => f.path));
    const targets: readonly DocumentFile[] = [
      ...detection.newFiles,
      ...detection.modifiedFiles,
    ];
    for (const file of targets) {
      const fileStatusOnSuccess: "indexed" | "modified" = newSet.has(file.path)
        ? "indexed"
        : "modified";
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
          ...(maxFileSizeBytes !== undefined ? { maxFileSizeBytes } : {}),
          ...(aiFallback !== undefined ? { aiFallback } : {}),
        });

        // AI fallback, `ask` mode: recognized as AI-extractable but
        // requires explicit user approval. Hold for review — do NOT
        // index into FTS and do NOT track in `panel_documents` (so it
        // keeps surfacing). `seenPaths` already contains this path, which
        // suppresses pruning of any prior entry while review is pending —
        // matching the expert processor's treatment of modified files.
        if (extracted.metadata?.askUser === true) {
          needsReview += 1;
          onProgress?.({
            filename: file.filename,
            source: folder.source,
            status: "needs-review",
          });
          files.push({
            path: file.path,
            filename: file.filename,
            extension: path.extname(file.path).toLowerCase(),
            status: "needs-review",
            wordCount: extracted.wordCount,
            aiExtracted: true,
            ...(extracted.metadata.detectedFormat !== undefined
              ? { detectedFormat: extracted.metadata.detectedFormat }
              : {}),
          });
          continue;
        }
        // For `linked` sources, the (link-membership re-check + FTS
        // DELETE+INSERT + panel_documents UPSERT) sequence MUST run as
        // a single atomic unit (issue #424). Without the transaction
        // wrap, a concurrent `panel docs unlink` that committed
        // between our re-check and our subsequent writes would have
        // its FTS + panel_documents deletes silently undone — leaving
        // the unlinked folder's content retrievable after a
        // reported-success unlink. We use `BEGIN IMMEDIATE` so the
        // writer lock is taken at the start: in multi-process
        // operation (e.g. `panel docs unlink` running in one terminal
        // while `chat <panel>` runs in another) SQLite serializes the
        // two transactions, and our SELECT sees the committed result
        // of whichever ran first. The FTS DELETE+INSERT block here
        // mirrors the body of `indexer.index()` (which opens its own
        // transaction we cannot nest inside another); managed-source
        // files still go through `indexer.index()` since the managed
        // dir cannot be unlinked.
        if (folder.source === "linked") {
          let skipped = false;
          await sql`BEGIN IMMEDIATE`.execute(db);
          try {
            const linkRow = await sql<{
              c: number;
            }>`SELECT COUNT(*) AS c FROM panel_linked_folders WHERE panel_name = ${panelName} AND folder_path = ${folder.path}`.execute(
              db,
            );
            if ((linkRow.rows[0]?.c ?? 0) === 0) {
              await sql`COMMIT`.execute(db);
              // Drop from `seenPaths` so the prune pass is free to
              // reconcile the (already-unlinked) row if it still
              // exists in `known`.
              seenPaths.delete(file.path);
              skipped = true;
            } else {
              await sql`DELETE FROM document_index WHERE file_path = ${file.path}`.execute(
                db,
              );
              await sql`INSERT INTO document_index (content, source_type, source_slug, file_path) VALUES (${extracted.content}, 'panel', ${panelName}, ${file.path})`.execute(
                db,
              );
              await docsRepo.trackDocument({
                panelName,
                source: folder.source,
                filePath: file.path,
                filename: file.filename,
                checksum: extracted.checksum,
                sizeBytes: extracted.sizeBytes,
                wordCount: extracted.wordCount,
              });
              await sql`COMMIT`.execute(db);
            }
          } catch (err) {
            try {
              await sql`ROLLBACK`.execute(db);
            } catch {
              /* preserve original error */
            }
            throw err;
          }
          if (skipped) {
            // File from a linked folder that was unlinked mid-scan (#528).
            // Report as skipped before continuing to next file.
            onProgress?.({
              filename: file.filename,
              source: folder.source,
              status: "unchanged",
            });
            files.push({
              path: file.path,
              filename: file.filename,
              extension: path.extname(file.path).toLowerCase(),
              status: "unchanged",
            });
            continue;
          }
        } else {
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
        }
        indexed += 1;
        onProgress?.({ filename: file.filename, source: folder.source, status: "indexed" });
        const aiExtracted = extracted.metadata?.aiFallback === true;
        files.push({
          path: file.path,
          filename: file.filename,
          extension: path.extname(file.path).toLowerCase(),
          status: fileStatusOnSuccess,
          wordCount: extracted.wordCount,
          ...(extracted.metadata !== undefined ? { metadata: extracted.metadata } : {}),
          ...(aiExtracted ? { aiExtracted: true } : {}),
          ...(aiExtracted && extracted.metadata?.detectedFormat !== undefined
            ? { detectedFormat: extracted.metadata.detectedFormat }
            : {}),
        });
      } catch (err: unknown) {
        failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        onProgress?.({
          filename: file.filename,
          source: folder.source,
          status: "failed",
          error: msg,
        });
        const classified = classifyExtractionError(err);
        if (classified.kind === "unsupported-format") {
          // Extension IS in supportedFormats but no native extractor
          // exists (AI fallback off/declined): keep `unsupported`
          // consistent with the detector-filtered path above.
          unsupported += 1;
        }
        files.push({
          path: file.path,
          filename: file.filename,
          extension: path.extname(file.path).toLowerCase(),
          status: "failed",
          errorKind: classified.kind,
          errorMessage: classified.message,
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

  return {
    indexed,
    unchanged,
    failed,
    needsReview,
    unsupported,
    pruned,
    foldersFailed,
    managedFolderFailed,
    files,
  };
}

function isUnderFolder(filePath: string, folderPath: string): boolean {
  if (filePath === folderPath) return true;
  return (
    filePath.startsWith(folderPath + "/") || filePath.startsWith(folderPath + "\\")
  );
}

/**
 * Resolve the canonical form of a path that no longer exists by walking
 * up to the closest existing ancestor, canonicalizing it via realpath,
 * and reattaching the missing tail. Used when the managed docs folder
 * has been deleted: tracked file paths in `panel_documents` were stored
 * under the original (pre-deletion) canonical root — e.g. on macOS,
 * `/tmp/foo` resolves to `/private/tmp/foo` — so a raw deleted path
 * prefix won't match. Returns the input unchanged if no ancestor
 * exists.
 */
async function resolveMissingPath(p: string): Promise<string> {
  const segments: string[] = [];
  let current = p;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return segments.length === 0 ? real : path.join(real, ...segments.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p;
      segments.push(path.basename(current));
      current = parent;
    }
  }
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
  if (result.needsReview > 0) return null;
  return `⚠ All ${result.failed} documents failed to process. Check file formats and permissions.`;
}
