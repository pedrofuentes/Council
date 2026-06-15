/**
 * Document processor (Roadmap 6.4) — orchestrates the on-demand
 * document pipeline for persona experts.
 *
 * Pipeline per `process()` invocation:
 *   1. Load known checksums from the `expert_documents` table.
 *   2. `detectDocumentChanges()` classifies the docs folder into
 *      new / modified / unchanged.
 *   3. For each new or modified file:
 *        - `extractDocument()` with `confinementRoot = docsPath`
 *          (TOCTOU-safe; rejects symlinks pointing outside the folder).
 *        - `indexer.index()` writes/replaces the FTS5 entry.
 *        - The DB row is created (new file) or its checksum/word-count
 *          updated (modified). Status flipped to `processed`.
 *      Per-file failures are isolated: the file is skipped and
 *      reported via the progress callback; processing continues with
 *      remaining files.
 *   4. If at least one file was processed, `analyzeDocuments()` runs
 *      and the result is upserted via `ProfileRepository.upsert()`.
 *      Analyzer failure is non-fatal: the existing profile (if any)
 *      is preserved and `profileUpdated: false` is reported.
 *
 * `needsProcessing()` is a cheap pre-check: returns true iff the
 * detector finds at least one new or modified file. Designed to be
 * called from chat startup so we only show progress UX when there's
 * actually work to do.
 */
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";

import { detectDocumentChanges } from "./detector.js";
import { extractDocument, type AiFallbackOption } from "./extractor.js";
import {
  analyzeDocuments,
  type DocumentContent as AnalyzerDoc,
  type PersonaProfile,
} from "./profile-analyzer.js";
import type { DocumentIndexer } from "./indexer.js";
import {
  classifyExtractionError,
  type ScanFileDetail,
} from "./scan-types.js";
import type { DocumentRepository } from "../../memory/repositories/document-repository.js";
import type { ProfileRepository } from "../../memory/repositories/profile-repository.js";
import type { CouncilEngine } from "../../engine/index.js";

export interface ProcessingResult {
  readonly filesProcessed: number;
  readonly filesSkipped: number;
  readonly filesFailed: number;
  readonly filesRemoved: number;
  /**
   * Count of files held for manual review (AI fallback `ask` mode):
   * detected as AI-extractable but NOT indexed into FTS and NOT tracked,
   * pending explicit user approval. Surfaced by scan UX as needs-review.
   */
  readonly filesNeedingReview: number;
  readonly totalWords: number;
  readonly profileUpdated: boolean;
  /**
   * When the analyzer or profile upsert failed, this is a short
   * description suitable for logging. `null` when profile refresh
   * succeeded or wasn't attempted.
   */
  readonly profileError: string | null;
  /**
   * Per-file processing details (Task T12). Mirrors the scanner's
   * `files` field: one entry per discovered document with status,
   * extension, word count, format metadata, and classified failure
   * kind. Used by `formatScanSummary` to render expert-document
   * processing output.
   */
  readonly files: readonly ScanFileDetail[];
}

export interface ProcessingProgress {
  readonly filename: string;
  readonly wordCount: number;
  readonly status: "success" | "failed" | "needs-review";
  readonly error?: string;
}

export interface DocumentProcessor {
  process(
    expertSlug: string,
    docsPath: string,
    onProgress?: (progress: ProcessingProgress) => void,
    onWarning?: (message: string) => void,
  ): Promise<ProcessingResult>;

  needsProcessing(expertSlug: string, docsPath: string): Promise<boolean>;
}

export interface DocumentProcessorOptions {
  readonly engine: CouncilEngine;
  readonly documentRepo: DocumentRepository;
  readonly profileRepo: ProfileRepository;
  readonly indexer: DocumentIndexer;
  readonly config: {
    readonly supportedFormats: readonly string[];
    readonly recencyHalfLifeDays: number;
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
     * indexes AI-extracted content (flagged `aiExtracted`); `ask` holds
     * the file as needs-review without indexing.
     */
    readonly aiFallback?: AiFallbackOption;
  };
  /**
   * Test-only seam: forwarded to the detector as `_lstatOverride`.
   * Lets reconciliation tests inject per-file lstat failures without
   * patching the `node:fs/promises` ESM namespace (whose bindings
   * are non-configurable on V8).
   */
  readonly _detectorLstatOverride?: (p: string) => Promise<Stats>;
}

export function createDocumentProcessor(
  options: DocumentProcessorOptions,
): DocumentProcessor {
  const { engine, documentRepo, profileRepo, indexer, config } = options;
  const detectorLstatOverride = options._detectorLstatOverride;

  /**
   * Resolve and freeze the docs root's canonical identity ONCE at entry.
   * Returns the canonical path so all downstream confinement checks
   * compare against the same immutable string — closing the race window
   * where a post-entry path swap could re-anchor confinement to an
   * attacker-chosen target. Also rejects symlinked roots outright.
   *
   * Returns `null` when the root does not exist (so the underlying scan
   * can produce an empty result without throwing).
   */
  async function resolveRealRoot(docsPath: string): Promise<string | null> {
    let stat;
    try {
      stat = await fs.lstat(docsPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `documents: docs root ${docsPath} is a symlink/junction; refusing to follow it for confinement safety`,
      );
    }
    return fs.realpath(docsPath);
  }

  return {
    async needsProcessing(expertSlug: string, docsPath: string): Promise<boolean> {
      const rootCanonical = await resolveRealRoot(docsPath);
      if (rootCanonical === null) return false;
      const known = await documentRepo.getChecksumMap(expertSlug);
      const detection = await detectDocumentChanges(
        rootCanonical,
        known,
        config.supportedFormats,
        { confinementRoot: rootCanonical, _rootIsCanonical: true },
      );
      if (detection.newFiles.length > 0 || detection.modifiedFiles.length > 0) {
        return true;
      }
      const present = new Set<string>([
        ...detection.newFiles.map((f) => f.path),
        ...detection.modifiedFiles.map((f) => f.path),
        ...detection.unchangedFiles.map((f) => f.path),
      ]);
      for (const tracked of known.keys()) {
        if (!present.has(tracked)) return true;
      }
      return false;
    },

    async process(
      expertSlug: string,
      docsPath: string,
      onProgress?: (progress: ProcessingProgress) => void,
      onWarning?: (message: string) => void,
    ): Promise<ProcessingResult> {
      const rootCanonical = await resolveRealRoot(docsPath);
      const known = await documentRepo.getChecksumMap(expertSlug);
      const detection =
        rootCanonical === null
          ? {
              newFiles: [],
              modifiedFiles: [],
              unchangedFiles: [],
              unsupportedFiles: [],
              rejectedFiles: [],
              unknownStateFiles: [],
            }
          : await detectDocumentChanges(
              rootCanonical,
              known,
              config.supportedFormats,
              {
                confinementRoot: rootCanonical,
                _rootIsCanonical: true,
                ...(onWarning ? { onWarning } : {}),
                ...(detectorLstatOverride
                  ? { _lstatOverride: detectorLstatOverride }
                  : {}),
              },
            );

      const toProcess = [...detection.newFiles, ...detection.modifiedFiles];
      const newSet = new Set(detection.newFiles.map((f) => f.path));
      const skipped = detection.unchangedFiles.length;

      let processed = 0;
      let failed = 0;
      let removed = 0;
      let needsReview = 0;
      let totalWords = 0;
      const successfullyExtracted: AnalyzerDoc[] = [];
      const files: ScanFileDetail[] = [];

      for (const u of detection.unchangedFiles) {
        files.push({
          path: u.path,
          filename: path.basename(u.path),
          extension: path.extname(u.path).toLowerCase(),
          status: "unchanged",
        });
      }

      // Reconcile deletions: any tracked file that did not appear in the
      // current scan (and wasn't merely rejected by confinement) is
      // marked removed in `expert_documents` and pruned from the FTS
      // index, so deleted content cannot continue influencing retrieval
      // or persona analysis.
      const seenPaths = new Set<string>([
        ...detection.newFiles.map((f) => f.path),
        ...detection.modifiedFiles.map((f) => f.path),
        ...detection.unchangedFiles.map((f) => f.path),
        ...detection.rejectedFiles,
        // Transient per-file failures (lstat/read errors — #342) must
        // also suppress prune so a flaky filesystem moment doesn't
        // delete persisted state.
        ...detection.unknownStateFiles,
      ]);
      for (const trackedPath of known.keys()) {
        if (seenPaths.has(trackedPath)) continue;
        const existing = await documentRepo.findByPath(expertSlug, trackedPath);
        if (!existing) continue;
        await indexer.remove(trackedPath);
        await documentRepo.markRemoved(existing.id);
        removed += 1;
      }

      // Confinement-rejected files (symlinks pointing outside docsPath,
      // post-open inode swaps, etc.) are reported up-front as failures
      // so callers see them in the progress stream without ever reading
      // their bytes.
      for (const rejected of detection.rejectedFiles) {
        failed += 1;
        onProgress?.({
          filename: path.basename(rejected),
          wordCount: 0,
          status: "failed",
          error: "rejected: outside confinement root or TOCTOU mismatch",
        });
        files.push({
          path: rejected,
          filename: path.basename(rejected),
          extension: path.extname(rejected).toLowerCase(),
          status: "failed",
          errorKind: "confinement-violation",
          errorMessage: "rejected: outside confinement root or TOCTOU mismatch",
        });
      }

      for (const file of toProcess) {
        try {
          const extracted = await extractDocument(file.path, {
            confinementRoot: rootCanonical ?? docsPath,
            _rootIsCanonical: rootCanonical !== null,
            ...(config.maxFileSizeBytes !== undefined
              ? { maxFileSizeBytes: config.maxFileSizeBytes }
              : {}),
            ...(config.aiFallback !== undefined
              ? { aiFallback: config.aiFallback }
              : {}),
          });

          // AI fallback, `ask` mode: the file was recognized as
          // AI-extractable but requires explicit user approval. Hold it
          // for review — do NOT index into FTS, do NOT track in
          // `expert_documents` (so it keeps surfacing), and do NOT feed it
          // to the persona analyzer. Recorded as a distinct needs-review
          // outcome for scan UX.
          if (extracted.metadata?.askUser === true) {
            needsReview += 1;
            onProgress?.({
              filename: file.filename,
              wordCount: extracted.wordCount,
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

          await indexer.index({
            content: extracted.content,
            sourceType: "expert",
            sourceSlug: expertSlug,
            filePath: file.path,
          });

          const existing = await documentRepo.findByPath(expertSlug, file.path);
          const now = new Date().toISOString();
          if (existing) {
            await documentRepo.updateChecksum(
              existing.id,
              extracted.checksum,
              extracted.sizeBytes,
              extracted.wordCount,
            );
            await documentRepo.updateStatus(existing.id, "processed", now);
          } else {
            const created = await documentRepo.create({
              expertSlug,
              filePath: file.path,
              filename: file.filename,
              checksum: extracted.checksum,
              sizeBytes: extracted.sizeBytes,
              wordCount: extracted.wordCount,
            });
            await documentRepo.updateStatus(created.id, "processed", now);
          }

          processed += 1;
          totalWords += extracted.wordCount;
          // mtime comes from the extractor's fd-bound stat (issue #376):
          // reading via `fh.stat()` during extraction guarantees the
          // mtime corresponds to the inode the content was read from,
          // closing the TOCTOU window that a separate post-extraction
          // `fs.stat(path)` would open.
          const analyzerDoc: AnalyzerDoc = {
            path: extracted.path,
            filename: extracted.filename,
            content: extracted.content,
            wordCount: extracted.wordCount,
            modifiedAt: extracted.modifiedAt,
          };
          successfullyExtracted.push(analyzerDoc);

          onProgress?.({
            filename: file.filename,
            wordCount: extracted.wordCount,
            status: "success",
          });
          const aiExtracted = extracted.metadata?.aiFallback === true;
          files.push({
            path: file.path,
            filename: file.filename,
            extension: path.extname(file.path).toLowerCase(),
            status: newSet.has(file.path) ? "indexed" : "modified",
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
            wordCount: 0,
            status: "failed",
            error: msg,
          });
          const classified = classifyExtractionError(err);
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

      let profileUpdated = false;
      let profileError: string | null = null;
      if (successfullyExtracted.length > 0) {
        try {
          const models = await engine.listModels();
          const model = models[0];
          if (model === undefined) {
            throw new Error("documents: no engine models available for analysis");
          }
          const existingProfile: PersonaProfile | null =
            await profileRepo.findBySlug(expertSlug);
          const profile = await analyzeDocuments(
            successfullyExtracted,
            existingProfile,
            engine,
            {
              recencyWeightHalfLife: config.recencyHalfLifeDays,
              model,
            },
          );
          await profileRepo.upsert(expertSlug, profile);
          profileUpdated = true;
        } catch (err: unknown) {
          // Non-fatal: existing profile (if any) is preserved, but
          // surface a diagnostic so the caller can warn the user.
          profileUpdated = false;
          profileError = err instanceof Error ? err.message : String(err);
        }
      }

      return {
        filesProcessed: processed,
        filesSkipped: skipped,
        filesFailed: failed,
        filesRemoved: removed,
        filesNeedingReview: needsReview,
        totalWords,
        profileUpdated,
        profileError,
        files,
      };
    },
  };
}
