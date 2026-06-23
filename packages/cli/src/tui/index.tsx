import path from "node:path";
import { render } from "ink";

import { getCouncilDataHome, getCouncilHome, loadConfig } from "../config/index.js";
import { FileExpertLibrary } from "../core/expert-library.js";
import { listTemplates, loadTemplate } from "../core/template-loader.js";
import { createDatabase } from "../memory/db.js";
import { ChatRepository } from "../memory/repositories/chat-repository.js";
import { DebateRepository } from "../memory/repositories/debates.js";
import { ExpertRepository } from "../memory/repositories/experts.js";
import { PanelLibraryRepository } from "../memory/repositories/panel-library-repo.js";
import { PanelRepository } from "../memory/repositories/panels.js";
import { TurnRepository } from "../memory/repositories/turns.js";
import { loadTranscript } from "../memory/transcript.js";
import { updateConfigFields } from "../config/loader.js";
import { createExpertAuthoringSource } from "./adapters/expert-authoring.js";
import { createExpertsDataSource } from "./adapters/experts-data.js";
import { createPanelsDataSource } from "./adapters/panels-data.js";
import { createSettingsDataSource } from "./adapters/config-settings.js";
import { createSessionsDataSource } from "./adapters/sessions-data.js";
import { createHomeDataSources } from "./adapters/home-data-sources.js";
import { loadHomeData } from "./adapters/home-data.js";
import { DataProvider, type TuiDataSources } from "./components/DataProvider.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { CouncilTUI } from "./CouncilTUI.js";

export async function launchTui(): Promise<void> {
  const config = await loadConfig();
  const dataHome = getCouncilDataHome(config);
  const dbPath = path.join(getCouncilHome(), "council.db");
  const db = await createDatabase(dbPath);

  const sources = createHomeDataSources({
    chat: new ChatRepository(db),
    panels: new PanelRepository(db),
    experts: new ExpertRepository(db),
  });

  const homeData = await loadHomeData(sources);
  const expertLibrary = new FileExpertLibrary(dataHome, db);
  const dataSources: TuiDataSources = {
    panels: createPanelsDataSource({
      library: new PanelLibraryRepository(db),
      experts: expertLibrary,
      listTemplates,
      loadTemplate,
    }),
    experts: createExpertsDataSource({ library: expertLibrary }),
    expertAuthoring: createExpertAuthoringSource({ library: expertLibrary }),
    settings: createSettingsDataSource({ loadConfig, updateConfigFields }),
    sessions: createSessionsDataSource({
      panels: new PanelRepository(db),
      debates: new DebateRepository(db),
      turns: new TurnRepository(db),
      loadTranscript: async (panelName: string) => {
        try {
          return await loadTranscript(db, panelName);
        } catch {
          return undefined;
        }
      },
    }),
  };
  const model = config.defaults.model;

  const { waitUntilExit } = render(
    <ErrorBoundary
      onError={(error: Error) => {
        console.error("Council TUI error:", error);
        process.exit(1);
      }}
    >
      <DataProvider value={dataSources}>
        <CouncilTUI homeData={homeData} model={model} />
      </DataProvider>
    </ErrorBoundary>,
    { alternateScreen: true, incrementalRendering: true },
  );

  try {
    await waitUntilExit();
  } finally {
    await db.destroy();
  }
}
