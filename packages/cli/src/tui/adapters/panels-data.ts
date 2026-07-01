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
    getMemberCounts(): Promise<ReadonlyMap<string, number>>;
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

/**
 * List the available template panels, isolating any listing/loading failure.
 *
 * #1817: an unguarded `listTemplates` (or `loadTemplate`) rejection used to
 * bubble out of {@link PanelsDataSource.loadList} and discard the
 * already-resolved saved panels the user does have. The list view has no error
 * channel, so a template failure degrades *only* this portion to an empty list;
 * the saved panels are still returned (and rendered) by the caller.
 */
async function loadTemplateItems(repos: PanelsRepos): Promise<readonly PanelListItem[]> {
  try {
    const templateNames = await repos.listTemplates();
    return await Promise.all(
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
  } catch {
    return [];
  }
}

export function createPanelsDataSource(repos: PanelsRepos): PanelsDataSource {
  return {
    loadList: async (): Promise<readonly PanelListItem[]> => {
      const [savedPanels, memberCounts] = await Promise.all([
        repos.library.findAll(),
        repos.library.getMemberCounts(),
      ]);
      const savedItems = savedPanels.map(
        (panel): PanelListItem => ({
          name: panel.name,
          description: panel.description ?? "",
          memberCount: memberCounts.get(panel.name) ?? 0,
          source: "saved",
        }),
      );

      const templateItems = await loadTemplateItems(repos);

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
