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

export interface StageDocumentFilesOptions {
  /**
   * Maximum accepted source size in MB, mirrored from
   * `documents.maxFileSizeMB`. A source whose size exceeds this ceiling is
   * rejected BEFORE any copy, so a hostile oversized file can never be staged
   * (and no partial batch is left behind). When omitted, no size ceiling is
   * enforced.
   */
  readonly maxFileSizeMB?: number;
}

/**
 * True when `error` is a Node system error carrying an errno `code` string
 * (e.g. `ENOENT`, `EACCES`, `EIO`).
 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "string";
}

/**
 * Whether a staged destination already exists. Only a genuinely-absent path
 * (`ENOENT`) is reported as "free to write"; any other `lstat` failure
 * (`EACCES`, `EIO`, `ELOOP`, …) is a real filesystem anomaly that must
 * propagate rather than be misread as "safe to overwrite" and allow the copy
 * to clobber content or mask a fault.
 */
async function destinationExists(destination: string): Promise<boolean> {
  try {
    await fs.lstat(destination);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Best-effort rollback of the destinations created by a single
 * {@link stageDocumentFiles} call. `COPYFILE_EXCL` guarantees every entry was
 * freshly created by this call (an existing document makes the copy fail), so
 * removing them can never delete pre-existing persona content. Rollback errors
 * are swallowed so the ORIGINAL failure is the one that propagates.
 */
async function rollbackStagedFiles(destinations: readonly string[]): Promise<void> {
  for (const destination of [...destinations].reverse()) {
    await fs.rm(destination, { force: true }).catch(() => undefined);
  }
}

/**
 * Copy user-selected document files into an expert's docs directory before
 * training, defending against four ingestion hazards:
 *
 *  - **Symlink escape**: `lstat` (not `stat`) is used so a symlink resolves
 *    to a non-regular-file and is rejected, preventing a crafted link from
 *    smuggling an out-of-tree file into the docs dir for indexing/analysis.
 *  - **Oversized input**: a source whose size exceeds `maxFileSizeMB` is
 *    rejected BEFORE any copy, so a hostile large file can never be staged
 *    and later exhaust memory during extraction.
 *  - **Silent overwrite**: `COPYFILE_EXCL` makes the copy fail if a document
 *    of the same name already exists, so existing persona content is never
 *    clobbered. The existence pre-check narrows to `ENOENT` only, so a
 *    transient `EACCES`/`EIO` surfaces instead of being read as "absent".
 *  - **Partial batch**: if any file fails after earlier ones were copied, the
 *    already-staged destinations are rolled back, so a mid-batch failure never
 *    leaves orphaned documents behind.
 *
 * The destination is always `<docsPath>/<basename>`, so a staged file can
 * never be written outside the docs directory.
 */
export async function stageDocumentFiles(
  docsPath: string,
  paths: readonly string[],
  options: StageDocumentFilesOptions = {},
): Promise<void> {
  const maxBytes =
    options.maxFileSizeMB === undefined ? undefined : options.maxFileSizeMB * 1024 * 1024;

  await fs.mkdir(docsPath, { recursive: true });

  // Destinations created by THIS call, so a later failure can roll them back.
  const staged: string[] = [];
  try {
    for (const inputPath of paths) {
      const stats = await fs.lstat(inputPath);
      if (!stats.isFile()) {
        throw new Error(`Document path is not a regular file: ${inputPath}`);
      }
      if (maxBytes !== undefined && stats.size > maxBytes) {
        // The basename is file-derived, so sanitize it before it can reach a
        // terminal; the byte count and MB ceiling are numeric and safe.
        const name = toSingleLineDisplay(path.basename(inputPath));
        throw new Error(
          `Document "${name}" is too large: ${stats.size} bytes exceeds the ${options.maxFileSizeMB} MB limit.`,
        );
      }
      const destination = path.join(docsPath, path.basename(inputPath));
      if (await destinationExists(destination)) {
        throw new Error(
          `A document named "${path.basename(inputPath)}" already exists for this persona.`,
        );
      }
      // COPYFILE_EXCL is a second line of defence: if another writer creates the
      // destination between the check above and this copy, the copy fails loudly
      // instead of silently overwriting existing persona content.
      await fs.copyFile(inputPath, destination, fsConstants.COPYFILE_EXCL);
      staged.push(destination);
    }
  } catch (error) {
    await rollbackStagedFiles(staged);
    throw error;
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
