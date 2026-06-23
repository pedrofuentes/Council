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

function sanitizeProgress(progress: ProcessingProgress): TrainingProgress {
  return {
    filename: toSingleLineDisplay(progress.filename),
    wordCount: progress.wordCount,
    status: progress.status,
    ...(progress.error === undefined ? {} : { error: toSingleLineDisplay(progress.error) }),
  };
}

function mapResult(result: ProcessingResult): TrainingResultView {
  return {
    filesProcessed: result.filesProcessed,
    filesFailed: result.filesFailed,
    filesSkipped: result.filesSkipped,
    filesNeedingReview: result.filesNeedingReview,
    totalWords: result.totalWords,
    profileUpdated: result.profileUpdated,
    profileError: result.profileError === null ? null : toSingleLineDisplay(result.profileError),
  };
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
        return mapResult(result);
      } finally {
        await engine.stop().catch(() => undefined);
      }
    },
  };
}
