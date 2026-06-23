export interface ExpertListItem {
  readonly slug: string;
  readonly displayName: string;
  readonly role: string;
  readonly kind: "generic" | "persona";
  readonly panelCount: number;
}

export interface ExpertDetailView {
  readonly slug: string;
  readonly displayName: string;
  readonly role: string;
  readonly kind: "generic" | "persona";
  readonly model?: string | undefined;
  readonly epistemicStance: string;
  readonly expertise: {
    readonly weightedEvidence: readonly string[];
    readonly referenceCases: readonly string[];
    readonly notExpertIn: readonly string[];
  };
  readonly personality?: string | undefined;
  readonly personaDescription?: string | undefined;
  readonly panels: readonly string[];
}

export interface ExpertDefLike {
  readonly slug: string;
  readonly displayName: string;
  readonly role: string;
  readonly kind: "generic" | "persona";
  readonly model?: string | undefined;
  readonly epistemicStance: string;
  readonly expertise: {
    readonly weightedEvidence: readonly string[];
    readonly referenceCases: readonly string[];
    readonly notExpertIn: readonly string[];
  };
  readonly personality?: string | undefined;
  readonly personaDescription?: string | undefined;
}

export interface ExpertsRepos {
  readonly library: {
    list(): Promise<readonly ExpertDefLike[]>;
    get(slug: string): Promise<ExpertDefLike | null>;
    panelsFor(slug: string): Promise<readonly string[]>;
  };
}

export interface ExpertsDataSource {
  readonly loadList: () => Promise<readonly ExpertListItem[]>;
  readonly loadDetail: (slug: string) => Promise<ExpertDetailView | undefined>;
}

function mapDetail(def: ExpertDefLike, panels: readonly string[]): ExpertDetailView {
  return {
    slug: def.slug,
    displayName: def.displayName,
    role: def.role,
    kind: def.kind,
    ...(def.model === undefined ? {} : { model: def.model }),
    epistemicStance: def.epistemicStance,
    expertise: {
      weightedEvidence: def.expertise.weightedEvidence,
      referenceCases: def.expertise.referenceCases,
      notExpertIn: def.expertise.notExpertIn,
    },
    ...(def.personality === undefined ? {} : { personality: def.personality }),
    ...(def.personaDescription === undefined ? {} : { personaDescription: def.personaDescription }),
    panels,
  };
}

export function createExpertsDataSource(repos: ExpertsRepos): ExpertsDataSource {
  return {
    loadList: async (): Promise<readonly ExpertListItem[]> => {
      const experts = await repos.library.list();
      return Promise.all(
        experts.map(async (expert): Promise<ExpertListItem> => {
          const panels = await repos.library.panelsFor(expert.slug);
          return {
            slug: expert.slug,
            displayName: expert.displayName,
            role: expert.role,
            kind: expert.kind,
            panelCount: panels.length,
          };
        }),
      );
    },
    loadDetail: async (slug: string): Promise<ExpertDetailView | undefined> => {
      const def = await repos.library.get(slug);
      if (def === null) return undefined;

      const panels = await repos.library.panelsFor(slug);
      return mapDetail(def, panels);
    },
  };
}
