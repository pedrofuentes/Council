// packages/cli/src/tui/adapters/home-data.ts
export interface RecentSession {
  readonly id: string;
  readonly title: string;
  readonly when: string;
  readonly status: "convened" | "concluded";
}

export interface HomeData {
  readonly counts: { readonly sessions: number; readonly experts: number; readonly panels: number };
  readonly recent: readonly RecentSession[];
}

export interface HomeDataSources {
  readonly listSessions: () => Promise<readonly RecentSession[]>;
  readonly countExperts: () => Promise<number>;
  readonly countPanels: () => Promise<number>;
}

const RECENT_LIMIT = 10;

export async function loadHomeData(sources: HomeDataSources): Promise<HomeData> {
  const [sessions, experts, panels] = await Promise.all([
    sources.listSessions(),
    sources.countExperts(),
    sources.countPanels(),
  ]);
  return {
    counts: { sessions: sessions.length, experts, panels },
    recent: sessions.slice(0, RECENT_LIMIT),
  };
}
