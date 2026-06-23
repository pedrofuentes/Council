import path from "node:path";
import { ulid } from "ulid";
import { render } from "ink";

import { DEFAULT_MODEL, getCouncilDataHome, getCouncilHome, loadConfig } from "../config/index.js";
import { FileExpertLibrary } from "../core/expert-library.js";
import { buildSystemPrompt } from "../core/prompt-builder.js";
import { resolveModel } from "../core/model-resolver.js";
import { createDocumentIndexer } from "../core/documents/indexer.js";
import { createDocumentProcessor } from "../core/documents/processor.js";
import { listTemplates, loadTemplate } from "../core/template-loader.js";
import { createDatabase } from "../memory/db.js";
import { ChatRepository } from "../memory/repositories/chat-repository.js";
import { DebateRepository } from "../memory/repositories/debates.js";
import { DocumentRepository } from "../memory/repositories/document-repository.js";
import { ExpertRepository } from "../memory/repositories/experts.js";
import { ProfileRepository } from "../memory/repositories/profile-repository.js";
import { PanelLibraryRepository } from "../memory/repositories/panel-library-repo.js";
import { PanelRepository } from "../memory/repositories/panels.js";
import { TurnRepository } from "../memory/repositories/turns.js";
import { loadTranscript } from "../memory/transcript.js";
import { updateConfigFields } from "../config/loader.js";
import { createExpertAuthoringSource } from "./adapters/expert-authoring.js";
import { createExpertDocumentsSource } from "./adapters/expert-documents.js";
import { createExpertsDataSource } from "./adapters/experts-data.js";
import { createPanelAuthoringSource } from "./adapters/panel-authoring.js";
import { createPanelComposeSource } from "./adapters/panel-compose.js";
import { createPanelsDataSource } from "./adapters/panels-data.js";
import { createSettingsDataSource } from "./adapters/config-settings.js";
import { createSessionsDataSource } from "./adapters/sessions-data.js";
import {
  createConveneSource,
  type ConveneDataSource,
  type ResolvedConvenePanel,
} from "./adapters/convene.js";
import { createExpertTrainingSource, stageDocumentFiles } from "./adapters/expert-training.js";
import { makeEngineFromKind } from "../cli/run-with-engine.js";
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
  const panelLibrary = new PanelLibraryRepository(db);
  const runtimePanels = new PanelRepository(db);
  const runtimeExperts = new ExpertRepository(db);
  const panelAuthoring = createPanelAuthoringSource({
    panelRepo: panelLibrary,
    expertExists: async (slug) => (await expertLibrary.get(slug)) !== null,
    dataHome,
    countDebates: async (name) => {
      const runtime = await new PanelRepository(db).findByNamePrefix(name);
      const exact = runtime.filter((panel) => panel.name === name);
      let total = 0;
      for (const panel of exact) {
        total += (await new DebateRepository(db).findByPanelId(panel.id)).length;
      }
      return total;
    },
  });
  const docsDirFor = (slug: string): string => path.join(dataHome, "experts", slug, "docs");

  const buildConvenePanel = async (
    panelName: string,
    topic: string,
    persistRuntimeRows: boolean,
  ): Promise<ResolvedConvenePanel> => {
    const libraryPanel = await panelLibrary.findByName(panelName);
    if (libraryPanel === undefined) {
      throw new Error(`Panel "${panelName}" not found`);
    }

    const slugs = await panelLibrary.getMembers(panelName);
    if (slugs.length === 0) {
      throw new Error(`Panel "${panelName}" has no experts`);
    }

    const definitions = [];
    for (const slug of slugs) {
      const definition = await expertLibrary.get(slug);
      if (definition === null) {
        throw new Error(`Panel "${panelName}" references missing expert "${slug}"`);
      }
      definitions.push(definition);
    }

    const experts = definitions.map((definition) => ({
      id: ulid(),
      slug: definition.slug,
      displayName: definition.displayName,
      model: resolveModel({
        expertModel: definition.model,
        configDefaultModel: config.defaults.model ?? DEFAULT_MODEL,
      }),
      systemMessage: buildSystemPrompt(definition, undefined, topic),
    }));

    const mode = "freeform" as const;
    const debateConfig = {
      maxRounds: config.defaults.maxRounds,
      maxWordsPerResponse: config.defaults.maxWordsPerResponse,
      mode,
      qualityGate: config.qualityGate,
    };

    if (!persistRuntimeRows) {
      return {
        experts,
        debateConfig,
        panelId: "estimate-only",
        expertSlugToId: {},
        moderator: "round-robin",
        mode,
        phaseCount: experts.length === 1 ? 3 : 4,
      };
    }

    const panel = await runtimePanels.create({
      name: `${panelName}-${new Date().toISOString().slice(0, 19)}`,
      topic,
      copilotHome: path.join(getCouncilHome(), "copilot"),
      configJson: JSON.stringify({
        template: panelName,
        mode,
        maxRounds: debateConfig.maxRounds,
        maxWords: debateConfig.maxWordsPerResponse,
        engine: config.defaults.engine,
      }),
    });

    const expertSlugToId: Record<string, string> = {};
    for (const expert of experts) {
      const row = await runtimeExperts.create({
        panelId: panel.id,
        slug: expert.slug,
        displayName: expert.displayName,
        model: expert.model,
        systemMessage: expert.systemMessage,
      });
      expertSlugToId[expert.slug] = row.id;
    }

    return {
      experts,
      debateConfig,
      panelId: panel.id,
      expertSlugToId,
      moderator: "round-robin",
      mode,
      phaseCount: experts.length === 1 ? 3 : 4,
    };
  };

  const convene: ConveneDataSource = {
    estimateCost: async (panelName) =>
      createConveneSource({
        engineFactory: () => makeEngineFromKind(config.defaults.engine),
        db,
        resolvePanel: async (name) => buildConvenePanel(name, "", false),
      }).estimateCost(panelName),
    streamDebate: async (panelName, topic, options, onEvent) =>
      createConveneSource({
        engineFactory: () => makeEngineFromKind(config.defaults.engine),
        db,
        resolvePanel: async (name) => buildConvenePanel(name, topic, true),
      }).streamDebate(panelName, topic, options, onEvent),
  };
  const dataSources: TuiDataSources = {
    panels: createPanelsDataSource({
      library: panelLibrary,
      experts: expertLibrary,
      listTemplates,
      loadTemplate,
    }),
    panelAuthoring,
    panelCompose: createPanelComposeSource({
      engineFactory: () => makeEngineFromKind(config.defaults.engine),
      defaultModel: config.defaults.model ?? DEFAULT_MODEL,
      library: expertLibrary,
      createPanel: panelAuthoring.create,
    }),
    experts: createExpertsDataSource({ library: expertLibrary }),
    expertAuthoring: createExpertAuthoringSource({ library: expertLibrary }),
    documents: createExpertDocumentsSource({
      repo: new DocumentRepository(db),
      indexer: createDocumentIndexer(db),
    }),
    training: createExpertTrainingSource({
      loadExpertKind: async (slug) => (await expertLibrary.get(slug))?.kind,
      stageFiles: (slug, paths) => stageDocumentFiles(docsDirFor(slug), paths),
      docsPathFor: docsDirFor,
      createProcessor: (engine) =>
        createDocumentProcessor({
          engine,
          documentRepo: new DocumentRepository(db),
          profileRepo: new ProfileRepository(db),
          indexer: createDocumentIndexer(db),
          config: {
            supportedFormats: config.expert.supportedFormats,
            recencyHalfLifeDays: config.expert.recencyHalfLifeDays,
            maxFileSizeBytes: config.documents.maxFileSizeMB * 1024 * 1024,
            aiFallback: {
              mode: config.documents.aiExtraction,
              allowedExtensions: config.documents.aiExtractionAllowedExtensions,
            },
          },
        }),
      engineFactory: () => makeEngineFromKind(config.defaults.engine),
    }),
    settings: createSettingsDataSource({ loadConfig, updateConfigFields }),
    convene,
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
