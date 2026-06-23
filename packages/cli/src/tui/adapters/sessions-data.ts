export type SessionStatus = "running" | "completed" | "interrupted" | "aborted" | "failed" | "none";

export interface SessionListItem {
  readonly panelId: string;
  readonly panelName: string;
  readonly topic: string;
  readonly debateCount: number;
  readonly turnCount: number;
  readonly latestStatus: SessionStatus;
  readonly updatedAt: string;
}

export interface SessionsRepos {
  readonly panels: {
    findAll(): Promise<
      readonly {
        readonly id: string;
        readonly name: string;
        readonly topic: string | null;
        readonly updatedAt: string;
      }[]
    >;
  };
  readonly debates: {
    findByPanelId(panelId: string): Promise<
      readonly {
        readonly id: string;
        readonly status: Exclude<SessionStatus, "none">;
        readonly startedAt: string;
      }[]
    >;
  };
  readonly turns: {
    countByDebateId(debateId: string): Promise<number>;
  };
}

export interface SessionsDataSource {
  readonly loadList: () => Promise<readonly SessionListItem[]>;
}

export function sessionStatusSymbol(status: SessionStatus): string {
  switch (status) {
    case "completed":
      return "✓";
    case "running":
      return "…";
    case "none":
      return "·";
    default:
      return "⚠";
  }
}

export function createSessionsDataSource(repos: SessionsRepos): SessionsDataSource {
  return {
    loadList: async (): Promise<readonly SessionListItem[]> => {
      const panels = await repos.panels.findAll();
      const items = await Promise.all(
        panels.map(async (panel): Promise<SessionListItem> => {
          const debates = await repos.debates.findByPanelId(panel.id);
          const turnCounts = await Promise.all(
            debates.map(async (debate): Promise<number> => repos.turns.countByDebateId(debate.id)),
          );
          const turnCount = turnCounts.reduce((total, count) => total + count, 0);
          const latest = [...debates].sort((left, right) =>
            right.startedAt.localeCompare(left.startedAt),
          )[0];

          return {
            panelId: panel.id,
            panelName: panel.name,
            topic: panel.topic ?? "",
            debateCount: debates.length,
            turnCount,
            latestStatus: latest?.status ?? "none",
            updatedAt: panel.updatedAt,
          };
        }),
      );

      return items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
  };
}
