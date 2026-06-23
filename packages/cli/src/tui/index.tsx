import path from "node:path";
import { render } from "ink";

import { getCouncilHome, loadConfig } from "../config/index.js";
import { createDatabase } from "../memory/db.js";
import { ChatRepository } from "../memory/repositories/chat-repository.js";
import { ExpertRepository } from "../memory/repositories/experts.js";
import { PanelRepository } from "../memory/repositories/panels.js";
import type { HomeDataSources } from "./adapters/home-data.js";
import { loadHomeData } from "./adapters/home-data.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { CouncilTUI } from "./CouncilTUI.js";

function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return "now";
}

export async function launchTui(): Promise<void> {
  const config = await loadConfig();
  const dbPath = path.join(getCouncilHome(), "council.db");
  const db = await createDatabase(dbPath);

  const chatRepo = new ChatRepository(db);
  const panelRepo = new PanelRepository(db);
  const expertRepo = new ExpertRepository(db);

  const sources: HomeDataSources = {
    listSessions: async () => {
      const sessions = await chatRepo.listSessions();
      return sessions.slice(0, 10).map((s) => ({
        id: s.id,
        title: s.summary ?? s.targetSlug,
        when: formatRelativeTime(s.updatedAt),
        status: s.status === "archived" ? "concluded" : "convened",
      }));
    },
    countExperts: async () => {
      const panels = await panelRepo.findAll();
      let total = 0;
      for (const panel of panels) {
        const experts = await expertRepo.findByPanelId(panel.id);
        total += experts.length;
      }
      return total;
    },
    countPanels: async () => {
      const panels = await panelRepo.findAll();
      return panels.length;
    },
  };

  const homeData = await loadHomeData(sources);
  const model = config.defaults.model;

  const { waitUntilExit } = render(
    <ErrorBoundary onError={(error: Error) => {
      console.error("Council TUI error:", error);
      process.exit(1);
    }}>
      <CouncilTUI homeData={homeData} model={model} />
    </ErrorBoundary>,
    { alternateScreen: true, incrementalRendering: true },
  );

  try {
    await waitUntilExit();
  } finally {
    await db.destroy();
  }
}
