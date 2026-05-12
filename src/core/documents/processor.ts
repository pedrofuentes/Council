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
  readonly totalWords: number;
  readonly profileUpdated: boolean;
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
}

export function createDocumentProcessor(
  options: DocumentProcessorOptions,
): DocumentProcessor {
  const { engine, documentRepo, profileRepo, indexer, config } = options;

  return {
    async needsProcessing(expertSlug: string, docsPath: string): Promise<boolean> {
      const known = await documentRepo.getChecksumMap(expertSlug);
      const detection = await detectDocumentChanges(
        docsPath,
        known,
        config.supportedFormats,
        { confinementRoot: docsPath },
      );
      return detection.newFiles.length > 0 || detection.modifiedFiles.length > 0;
    },

    async process(
      expertSlug: string,
      docsPath: string,
      onProgress?: (progress: ProcessingProgress) => void,
    ): Promise<ProcessingResult> {
      const known = await documentRepo.getChecksumMap(expertSlug);
      const detection = await detectDocumentChanges(
        docsPath,
        known,
        config.supportedFormats,
        { confinementRoot: docsPath },
      );

      const toProcess = [...detection.newFiles, ...detection.modifiedFiles];
      const skipped = detection.unchangedFiles.length;

      let processed = 0;
      let failed = 0;
      let totalWords = 0;
      const successfullyExtracted: AnalyzerDoc[] = [];

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
            confinementRoot: docsPath,
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
          successfullyExtracted.push({
            path: extracted.path,
            filename: extracted.filename,
            content: extracted.content,
            wordCount: extracted.wordCount,
          });

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
      if (successfullyExtracted.length > 0) {
        try {
          const models = await engine.listModels();
          const model = models[0];
          if (model === undefined) {
            throw new Error("engine returned no models for profile analysis");
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
        } catch {
          // Non-fatal: existing profile (if any) is preserved.
          profileUpdated = false;
        }
      }

      return {
        filesProcessed: processed,
        filesSkipped: skipped,
        filesFailed: failed,
        totalWords,
        profileUpdated,
      };
    },
  };
}
