import type { HomeDataSources, RecentSession } from "./home-data.js";

/** Minimal structural view of a chat session row consumed by the Home screen. */
export interface SessionRow {
  readonly id: string;
  readonly summary: string | null;
  readonly targetSlug: string;
  readonly updatedAt: string;
  readonly status: string;
}

/** Repositories the Home data sources read from (structural — accepts the real repos). */
export interface HomeRepos {
  readonly chat: { listSessions(): Promise<readonly SessionRow[]> };
  readonly panels: { findAll(): Promise<readonly { readonly id: string }[]> };
  readonly experts: { findByPanelId(panelId: string): Promise<readonly unknown[]> };
}

/** Formats an ISO timestamp as a compact relative age (e.g. "3d", "5h", "10m", "now"). */
export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const diff = Date.now() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return "now";
}

/** Maps a persisted chat session row to the Home screen's RecentSession view-model. */
export function toRecentSession(session: SessionRow): RecentSession {
  return {
    id: session.id,
    title: session.summary ?? session.targetSlug,
    when: formatRelativeTime(session.updatedAt),
    status: session.status === "archived" ? "concluded" : "convened",
  };
}

/** Builds the Home data sources from the repositories (used by the TUI entry point). */
export function createHomeDataSources(repos: HomeRepos): HomeDataSources {
  return {
    listSessions: async () => {
      const sessions = await repos.chat.listSessions();
      return sessions.map(toRecentSession);
    },
    countExperts: async () => {
      const panels = await repos.panels.findAll();
      let total = 0;
      for (const panel of panels) {
        const experts = await repos.experts.findByPanelId(panel.id);
        total += experts.length;
      }
      return total;
    },
    countPanels: async () => {
      const panels = await repos.panels.findAll();
      return panels.length;
    },
  };
}
