import * as fs from "node:fs/promises";
import path from "node:path";

import { makeEngineFromKind } from "../cli/run-with-engine.js";
import type { CouncilConfig } from "../config/index.js";
import { createDocumentIndexer } from "../core/documents/indexer.js";
import { createDocumentProcessor } from "../core/documents/processor.js";
import type { FileExpertLibrary } from "../core/expert-library.js";
import type { CouncilDatabase } from "../memory/db.js";
import { DocumentRepository } from "../memory/repositories/document-repository.js";
import { ProfileRepository } from "../memory/repositories/profile-repository.js";
import {
  createExpertTrainingSource,
  type ExpertTrainingDataSource,
} from "./adapters/expert-training.js";

export interface TrainingSourceFactoryDeps {
  readonly config: CouncilConfig;
  readonly dataHome: string;
  readonly db: CouncilDatabase;
  readonly expertLibrary: Pick<FileExpertLibrary, "get">;
}

export function createTuiTrainingSource(deps: TrainingSourceFactoryDeps): ExpertTrainingDataSource {
  const docsPathFor = (slug: string): string => path.join(deps.dataHome, "experts", slug, "docs");

  return createExpertTrainingSource({
    loadExpertKind: async (slug) => (await deps.expertLibrary.get(slug))?.kind,
    stageFiles: async (slug, paths) => {
      const docsPath = docsPathFor(slug);
      await fs.mkdir(docsPath, { recursive: true });
      for (const inputPath of paths) {
        const stat = await fs.stat(inputPath);
        if (!stat.isFile()) {
          throw new Error(`Document path is not a file: ${inputPath}`);
        }
        await fs.copyFile(inputPath, path.join(docsPath, path.basename(inputPath)));
      }
    },
    docsPathFor,
    createProcessor: (engine) =>
      createDocumentProcessor({
        engine,
        documentRepo: new DocumentRepository(deps.db),
        profileRepo: new ProfileRepository(deps.db),
        indexer: createDocumentIndexer(deps.db),
        config: {
          supportedFormats: deps.config.expert.supportedFormats,
          recencyHalfLifeDays: deps.config.expert.recencyHalfLifeDays,
          maxFileSizeBytes: deps.config.documents.maxFileSizeMB * 1024 * 1024,
          aiFallback: {
            mode: deps.config.documents.aiExtraction,
            allowedExtensions: deps.config.documents.aiExtractionAllowedExtensions,
          },
        },
      }),
    engineFactory: () => makeEngineFromKind(deps.config.defaults.engine),
  });
}
