export interface PanelListItem {
  readonly name: string;
  readonly description: string;
  readonly memberCount: number;
  readonly source: "saved" | "template";
}

export interface PanelMemberView {
  readonly slug: string;
  readonly displayName: string;
  readonly role: string;
  readonly kind: "generic" | "persona";
}

export interface PanelDetailView {
  readonly name: string;
  readonly description: string;
  readonly source: "saved" | "template";
  readonly defaults?: {
    readonly mode?: string;
    readonly maxRounds?: number;
    readonly model?: string;
  };
  readonly members: readonly PanelMemberView[];
  readonly missing: readonly string[];
}

export interface PanelsRepos {
  readonly library: {
    findAll(): Promise<readonly { readonly name: string; readonly description: string | null }[]>;
    findByName(
      name: string,
    ): Promise<{ readonly name: string; readonly description: string | null } | undefined>;
    getMembers(name: string): Promise<readonly string[]>;
  };
  readonly experts: {
    get(slug: string): Promise<{
      readonly displayName: string;
      readonly role: string;
      readonly kind: "generic" | "persona";
    } | null>;
  };
  readonly listTemplates: () => Promise<readonly string[]>;
  readonly loadTemplate: (name: string) => Promise<{
    readonly description?: string;
    readonly defaults?: {
      readonly mode?: string | undefined;
      readonly maxRounds?: number | undefined;
      readonly model?: string | undefined;
    } | undefined;
    readonly experts: readonly {
      readonly slug: string;
      readonly displayName: string;
      readonly role: string;
      readonly kind: "generic" | "persona";
    }[];
  }>;
}

export interface PanelsDataSource {
  readonly loadList: () => Promise<readonly PanelListItem[]>;
  readonly loadDetail: (
    name: string,
    source: "saved" | "template",
  ) => Promise<PanelDetailView | undefined>;
}

function mapTemplateDefaults(
  defaults:
    | {
        readonly mode?: string | undefined;
        readonly maxRounds?: number | undefined;
        readonly model?: string | undefined;
      }
    | undefined,
): PanelDetailView["defaults"] | undefined {
  if (defaults === undefined) return undefined;

  return {
    ...(defaults.mode === undefined ? {} : { mode: defaults.mode }),
    ...(defaults.maxRounds === undefined ? {} : { maxRounds: defaults.maxRounds }),
    ...(defaults.model === undefined ? {} : { model: defaults.model }),
  };
}

export function createPanelsDataSource(repos: PanelsRepos): PanelsDataSource {
  return {
    loadList: async (): Promise<readonly PanelListItem[]> => {
      const savedPanels = await repos.library.findAll();
      const savedItems = await Promise.all(
        savedPanels.map(async (panel): Promise<PanelListItem> => {
          const members = await repos.library.getMembers(panel.name);
          return {
            name: panel.name,
            description: panel.description ?? "",
            memberCount: members.length,
            source: "saved",
          };
        }),
      );

      const templateNames = await repos.listTemplates();
      const templateItems = await Promise.all(
        templateNames.map(async (name): Promise<PanelListItem> => {
          const template = await repos.loadTemplate(name);
          return {
            name,
            description: template.description ?? "",
            memberCount: template.experts.length,
            source: "template",
          };
        }),
      );

      return [...savedItems, ...templateItems];
    },
    loadDetail: async (
      name: string,
      source: "saved" | "template",
    ): Promise<PanelDetailView | undefined> => {
      if (source === "saved") {
        const panel = await repos.library.findByName(name);
        if (!panel) return undefined;

        const slugs = await repos.library.getMembers(name);
        const members: PanelMemberView[] = [];
        const missing: string[] = [];

        for (const slug of slugs) {
          const def = await repos.experts.get(slug);
          if (def) {
            members.push({
              slug,
              displayName: def.displayName,
              role: def.role,
              kind: def.kind,
            });
          } else {
            missing.push(slug);
          }
        }

        return {
          name: panel.name,
          description: panel.description ?? "",
          source,
          members,
          missing,
        };
      }

      const tpl = await repos.loadTemplate(name);
      const defaults = mapTemplateDefaults(tpl.defaults);
      return {
        name,
        description: tpl.description ?? "",
        source,
        ...(defaults === undefined ? {} : { defaults }),
        members: tpl.experts.map(
          (expert): PanelMemberView => ({
            slug: expert.slug,
            displayName: expert.displayName,
            role: expert.role,
            kind: expert.kind,
          }),
        ),
        missing: [],
      };
    },
  };
}
