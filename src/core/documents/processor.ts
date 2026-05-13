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
import { extractDocument } from "./extractor.js";
import {
  analyzeDocuments,
  type DocumentContent as AnalyzerDoc,
  type PersonaProfile,
} from "./profile-analyzer.js";
import type { DocumentIndexer } from "./indexer.js";
import type { DocumentRepository } from "../../memory/repositories/document-repository.js";
import type { ProfileRepository } from "../../memory/repositories/profile-repository.js";
import type { CouncilEngine } from "../../engine/index.js";

export interface ProcessingResult {
  readonly filesProcessed: number;
  readonly filesSkipped: number;
  readonly filesFailed: number;
  readonly filesRemoved: number;
  readonly totalWords: number;
  readonly profileUpdated: boolean;
  /**
   * When the analyzer or profile upsert failed, this is a short
   * description suitable for logging. `null` when profile refresh
   * succeeded or wasn't attempted.
   */
  readonly profileError: string | null;
}

export interface ProcessingProgress {
  readonly filename: string;
  readonly wordCount: number;
  readonly status: "success" | "failed";
  readonly error?: string;
}

export interface DocumentProcessor {
  process(
    expertSlug: string,
    docsPath: string,
    onProgress?: (progress: ProcessingProgress) => void,
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
                ...(detectorLstatOverride
                  ? { _lstatOverride: detectorLstatOverride }
                  : {}),
              },
            );

      const toProcess = [...detection.newFiles, ...detection.modifiedFiles];
      const skipped = detection.unchangedFiles.length;

      let processed = 0;
      let failed = 0;
      let removed = 0;
      let totalWords = 0;
      const successfullyExtracted: AnalyzerDoc[] = [];

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
      }

      for (const file of toProcess) {
        try {
          const extracted = await extractDocument(file.path, {
            confinementRoot: rootCanonical ?? docsPath,
            _rootIsCanonical: rootCanonical !== null,
          });

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
          // Carry modified-at so the analyzer can compute recency weights.
          // Best-effort: a stat failure (e.g. the file was just removed)
          // simply omits the date and the analyzer treats the doc as
          // un-weighted.
          let modifiedAt: string | undefined;
          try {
            const st = await fs.stat(extracted.path);
            modifiedAt = st.mtime.toISOString();
          } catch {
            modifiedAt = undefined;
          }
          const analyzerDoc: AnalyzerDoc =
            modifiedAt !== undefined
              ? {
                  path: extracted.path,
                  filename: extracted.filename,
                  content: extracted.content,
                  wordCount: extracted.wordCount,
                  modifiedAt,
                }
              : {
                  path: extracted.path,
                  filename: extracted.filename,
                  content: extracted.content,
                  wordCount: extracted.wordCount,
                };
          successfullyExtracted.push(analyzerDoc);

          onProgress?.({
            filename: file.filename,
            wordCount: extracted.wordCount,
            status: "success",
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
        totalWords,
        profileUpdated,
        profileError,
      };
    },
  };
}
