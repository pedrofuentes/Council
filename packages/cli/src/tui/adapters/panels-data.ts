export interface PanelListItem {
  readonly name: string;
  readonly description: string;
  readonly memberCount: number;
  readonly source: "saved" | "template";
}

export interface PanelsRepos {
  readonly library: {
    findAll(): Promise<readonly { readonly name: string; readonly description: string | null }[]>;
    getMembers(name: string): Promise<readonly string[]>;
  };
  readonly listTemplates: () => Promise<readonly string[]>;
  readonly loadTemplate: (name: string) => Promise<{
    readonly description?: string;
    readonly experts: readonly unknown[];
  }>;
}

export interface PanelsDataSource {
  readonly loadList: () => Promise<readonly PanelListItem[]>;
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
  };
}
