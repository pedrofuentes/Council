import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type {
  DocumentProcessor,
  ProcessingProgress,
  ProcessingResult,
} from "../../core/documents/processor.js";
import type { CouncilEngine } from "../../engine/index.js";

export interface TrainingResultView {
  readonly filesProcessed: number;
  readonly filesFailed: number;
  readonly filesSkipped: number;
  readonly filesNeedingReview: number;
  readonly totalWords: number;
  readonly profileUpdated: boolean;
  readonly profileError: string | null;
  /**
   * A display-safe warning when the engine failed to shut down after an
   * otherwise-successful training run, or `undefined` when shutdown succeeded.
   * Surfaced as a secondary signal so a teardown failure is never hidden yet
   * never masks the primary training result (#1635).
   */
  readonly stopWarning?: string;
}

export interface TrainingProgress {
  readonly filename: string;
  readonly wordCount: number;
  readonly status: "success" | "failed" | "needs-review";
  readonly error?: string;
}

export interface ExpertTrainingDataSource {
  train(
    slug: string,
    input: { readonly files: readonly string[] },
    onProgress?: (progress: TrainingProgress) => void,
  ): Promise<TrainingResultView>;
}

export interface ExpertTrainingDeps {
  readonly loadExpertKind: (slug: string) => Promise<"persona" | "generic" | undefined>;
  readonly stageFiles: (slug: string, paths: readonly string[]) => Promise<void>;
  readonly docsPathFor: (slug: string) => string;
  readonly createProcessor: (engine: CouncilEngine) => DocumentProcessor;
  readonly engineFactory: () => CouncilEngine;
}

/**
 * Copy user-selected document files into an expert's docs directory before
 * training, defending against two ingestion hazards:
 *
 *  - **Symlink escape**: `lstat` (not `stat`) is used so a symlink resolves
 *    to a non-regular-file and is rejected, preventing a crafted link from
 *    smuggling an out-of-tree file into the docs dir for indexing/analysis.
 *  - **Silent overwrite**: `COPYFILE_EXCL` makes the copy fail if a document
 *    of the same name already exists, so existing persona content is never
 *    clobbered. The caller surfaces the error instead of losing data.
 *
 * The destination is always `<docsPath>/<basename>`, so a staged file can
 * never be written outside the docs directory.
 */
export async function stageDocumentFiles(
  docsPath: string,
  paths: readonly string[],
): Promise<void> {
  await fs.mkdir(docsPath, { recursive: true });
  for (const inputPath of paths) {
    const stats = await fs.lstat(inputPath);
    if (!stats.isFile()) {
      throw new Error(`Document path is not a regular file: ${inputPath}`);
    }
    const destination = path.join(docsPath, path.basename(inputPath));
    const destinationExists = await fs
      .lstat(destination)
      .then(() => true)
      .catch(() => false);
    if (destinationExists) {
      throw new Error(
        `A document named "${path.basename(inputPath)}" already exists for this persona.`,
      );
    }
    // COPYFILE_EXCL is a second line of defence: if another writer creates the
    // destination between the check above and this copy, the copy fails loudly
    // instead of silently overwriting existing persona content.
    await fs.copyFile(inputPath, destination, fsConstants.COPYFILE_EXCL);
  }
}

function sanitizeProgress(progress: ProcessingProgress): TrainingProgress {
  return {
    filename: toSingleLineDisplay(progress.filename),
    wordCount: progress.wordCount,
    status: progress.status,
    ...(progress.error === undefined ? {} : { error: toSingleLineDisplay(progress.error) }),
  };
}

function mapResult(result: ProcessingResult, stopWarning: string | undefined): TrainingResultView {
  return {
    filesProcessed: result.filesProcessed,
    filesFailed: result.filesFailed,
    filesSkipped: result.filesSkipped,
    filesNeedingReview: result.filesNeedingReview,
    totalWords: result.totalWords,
    profileUpdated: result.profileUpdated,
    profileError: result.profileError === null ? null : toSingleLineDisplay(result.profileError),
    ...(stopWarning === undefined ? {} : { stopWarning }),
  };
}

/**
 * Stop the engine, turning a shutdown failure into a display-safe warning
 * instead of silently swallowing it (#1635). The engine's error message can
 * carry provider/model-derived text, so it is passed through
 * {@link toSingleLineDisplay} before it can reach a single-line terminal sink.
 * Returns `undefined` when shutdown succeeds.
 */
async function stopWithWarning(engine: CouncilEngine): Promise<string | undefined> {
  try {
    await engine.stop();
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toSingleLineDisplay(`Engine shutdown failed: ${message}`);
  }
}

export function createExpertTrainingSource(deps: ExpertTrainingDeps): ExpertTrainingDataSource {
  return {
    train: async (
      slug: string,
      input: { readonly files: readonly string[] },
      onProgress?: (progress: TrainingProgress) => void,
    ): Promise<TrainingResultView> => {
      const kind = await deps.loadExpertKind(slug);
      const displaySlug = toSingleLineDisplay(slug);
      if (kind === undefined) {
        throw new Error(`Expert "${displaySlug}" not found.`);
      }
      if (kind !== "persona") {
        throw new Error(
          `Expert "${displaySlug}" is not a persona expert — only persona experts can be trained.`,
        );
      }

      if (input.files.length > 0) {
        await deps.stageFiles(slug, input.files);
      }

      const engine = deps.engineFactory();
      const processor = deps.createProcessor(engine);
      try {
        await engine.start();
        const result = await processor.process(slug, deps.docsPathFor(slug), (progress) => {
          onProgress?.(sanitizeProgress(progress));
        });
        // Success path: surface a shutdown failure as a secondary warning on the
        // otherwise-successful result rather than swallowing it (#1635).
        return mapResult(result, await stopWithWarning(engine));
      } catch (error) {
        // Error path: a shutdown failure must never replace the primary training
        // error, so engine.stop() is best-effort and its rejection is dropped.
        await engine.stop().catch(() => undefined);
        throw error;
      }
    },
  };
}
