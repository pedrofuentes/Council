import { stripControlChars, toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { PersonaProfile } from "../../core/documents/profile-analyzer.js";
import type { ExpertDocument } from "../../memory/repositories/document-repository.js";

export interface ExpertMemoryDocuments {
  readonly count: number;
  readonly totalWords: number;
  readonly filenames: readonly string[];
}

export interface ExpertMemoryView {
  readonly hasMemory: boolean;
  readonly communicationStyle: string;
  readonly decisionPatterns: readonly string[];
  readonly biases: readonly string[];
  readonly vocabulary: readonly string[];
  readonly epistemicStance: string;
  readonly documentCount: number;
  readonly totalWords: number;
  readonly lastUpdated: string;
  readonly documents: ExpertMemoryDocuments;
}

export interface ExpertMemoryDeps {
  readonly profileRepo: {
    findBySlug(slug: string): Promise<PersonaProfile | null>;
  };
  readonly documentRepo: {
    findByExpert(slug: string): Promise<readonly ExpertDocument[]>;
  };
}

export interface ExpertMemoryDataSource {
  load(slug: string): Promise<ExpertMemoryView>;
}

const NO_MEMORY: ExpertMemoryView = {
  hasMemory: false,
  communicationStyle: "",
  decisionPatterns: [],
  biases: [],
  vocabulary: [],
  epistemicStance: "",
  documentCount: 0,
  totalWords: 0,
  lastUpdated: "",
  documents: { count: 0, totalWords: 0, filenames: [] },
};

export function createExpertMemorySource(deps: ExpertMemoryDeps): ExpertMemoryDataSource {
  return {
    load: async (slug: string): Promise<ExpertMemoryView> => {
      const profile = await deps.profileRepo.findBySlug(slug);
      if (profile === null) {
        return NO_MEMORY;
      }

      const documents = await deps.documentRepo.findByExpert(slug);
      const active = documents.filter((document) => document.status !== "removed");

      return {
        hasMemory: true,
        communicationStyle: stripControlChars(profile.communicationStyle),
        decisionPatterns: profile.decisionPatterns.map((value) => stripControlChars(value)),
        biases: profile.biases.map((value) => stripControlChars(value)),
        vocabulary: profile.vocabulary.map((value) => stripControlChars(value)),
        epistemicStance: stripControlChars(profile.epistemicStance),
        documentCount: profile.documentCount,
        totalWords: profile.totalWords,
        lastUpdated: toSingleLineDisplay(profile.lastUpdated),
        documents: {
          count: active.length,
          totalWords: active.reduce((sum, document) => sum + document.wordCount, 0),
          filenames: active.map((document) => toSingleLineDisplay(document.filename)),
        },
      };
    },
  };
}
