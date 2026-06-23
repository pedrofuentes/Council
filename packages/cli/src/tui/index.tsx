import path from "node:path";
import { render } from "ink";

import { getCouncilHome, loadConfig } from "../config/index.js";
import { createDatabase } from "../memory/db.js";
import { ChatRepository } from "../memory/repositories/chat-repository.js";
import { ExpertRepository } from "../memory/repositories/experts.js";
import { PanelRepository } from "../memory/repositories/panels.js";
import { createHomeDataSources } from "./adapters/home-data-sources.js";
import { loadHomeData } from "./adapters/home-data.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { CouncilTUI } from "./CouncilTUI.js";

export async function launchTui(): Promise<void> {
  const config = await loadConfig();
  const dbPath = path.join(getCouncilHome(), "council.db");
  const db = await createDatabase(dbPath);

  const sources = createHomeDataSources({
    chat: new ChatRepository(db),
    panels: new PanelRepository(db),
    experts: new ExpertRepository(db),
  });

  const homeData = await loadHomeData(sources);
  const model = config.defaults.model;

  const { waitUntilExit } = render(
    <ErrorBoundary
      onError={(error: Error) => {
        console.error("Council TUI error:", error);
        process.exit(1);
      }}
    >
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
