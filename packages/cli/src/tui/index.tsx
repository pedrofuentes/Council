import path from "node:path";
import { ulid } from "ulid";
import { render } from "ink";

import { DEFAULT_MODEL, getCouncilDataHome, getCouncilHome, loadConfig } from "../config/index.js";
import { FileExpertLibrary } from "../core/expert-library.js";
import { buildSystemPrompt } from "../core/prompt-builder.js";
import { resolveModel } from "../core/model-resolver.js";
import { createDocumentIndexer } from "../core/documents/indexer.js";
import { createDocumentProcessor } from "../core/documents/processor.js";
import { listTemplates, loadPanel, loadTemplate } from "../core/template-loader.js";
import { createDatabase } from "../memory/db.js";
import { ChatRepository } from "../memory/repositories/chat-repository.js";
import { DebateRepository } from "../memory/repositories/debates.js";
import { DocumentRepository } from "../memory/repositories/document-repository.js";
import { ExpertRepository } from "../memory/repositories/experts.js";
import { ProfileRepository } from "../memory/repositories/profile-repository.js";
import { PanelLibraryRepository } from "../memory/repositories/panel-library-repo.js";
import { PanelRepository } from "../memory/repositories/panels.js";
import { TurnRepository } from "../memory/repositories/turns.js";
import type { ExpertSpec } from "../engine/index.js";
import { loadTranscript } from "../memory/transcript.js";
import { updateConfigFields } from "../config/loader.js";
import { createExpertAuthoringSource } from "./adapters/expert-authoring.js";
import { createExpertDocumentsSource } from "./adapters/expert-documents.js";
import { createExpertMemorySource } from "./adapters/expert-memory.js";
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
import {
  createConvenePanelResolver,
  type ConvenePanelRuntimeInput,
} from "./adapters/convene-resolve.js";
import { createExpertTrainingSource, stageDocumentFiles } from "./adapters/expert-training.js";
import { createChatSessionSource } from "./adapters/chat-session.js";
import { createChatsDataSource } from "./adapters/chats-data.js";
import { createChatEngineSource } from "./adapters/chat-engine-session.js";
import { makeEngineFromKind } from "../cli/run-with-engine.js";
import { buildExpertSpec, CHAT_TASK_DESCRIPTION } from "../cli/commands/chat/shared.js";
import { getExpertPanelMemberships } from "../core/panel-membership-query.js";
import type { PanelMembership } from "../core/prompt-builder.js";
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
  const profileRepo = new ProfileRepository(db);
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

  const createBuildSpec =
    (
      topic: string,
    ): ((slug: string, panelDefaultModel: string | undefined) => Promise<ExpertSpec>) =>
    async (slug, panelDefaultModel) => {
      const definition = await expertLibrary.get(slug);
      if (definition === null) {
        throw new Error(`Panel references missing expert "${slug}"`);
      }
      return {
        id: ulid(),
        slug: definition.slug,
        displayName: definition.displayName,
        model: resolveModel({
          expertModel: definition.model,
          panelDefaultModel,
          configDefaultModel: config.defaults.model ?? DEFAULT_MODEL,
        }),
        systemMessage: buildSystemPrompt(definition, undefined, topic),
      };
    };

  const createResolvePanelId =
    (topic: string, persistRuntimeRows: boolean) =>
    async (
      input: ConvenePanelRuntimeInput,
    ): Promise<{
      readonly panelId: string;
      readonly expertSlugToId: Readonly<Record<string, string>>;
    }> => {
      if (!persistRuntimeRows) {
        return { panelId: "estimate-only", expertSlugToId: {} };
      }

      const panel = await runtimePanels.create({
        name: `${input.panelName}-${new Date().toISOString().slice(0, 19)}`,
        topic,
        copilotHome: path.join(getCouncilHome(), "copilot"),
        configJson: JSON.stringify({
          template: input.panelName,
          mode: input.mode,
          maxRounds: input.debateConfig.maxRounds,
          maxWords: input.debateConfig.maxWordsPerResponse,
          engine: config.defaults.engine,
        }),
      });

      const expertSlugToId: Record<string, string> = {};
      for (const expert of input.experts) {
        const row = await runtimeExperts.create({
          panelId: panel.id,
          slug: expert.slug,
          displayName: expert.displayName,
          model: expert.model,
          systemMessage: expert.systemMessage,
        });
        expertSlugToId[expert.slug] = row.id;
      }

      return { panelId: panel.id, expertSlugToId };
    };

  const buildConveneResolver = (
    topic: string,
    persistRuntimeRows: boolean,
  ): ((panelName: string) => Promise<ResolvedConvenePanel>) =>
    createConvenePanelResolver({
      loadPanel,
      getMembers: (name) => panelLibrary.getMembers(name),
      dataHome,
      config,
      buildSpec: createBuildSpec(topic),
      resolvePanelId: createResolvePanelId(topic, persistRuntimeRows),
    });

  const convene: ConveneDataSource = {
    estimateCost: async (panelName) =>
      createConveneSource({
        engineFactory: () => makeEngineFromKind(config.defaults.engine),
        db,
        resolvePanel: buildConveneResolver("", false),
      }).estimateCost(panelName),
    streamDebate: async (panelName, topic, options, onEvent) =>
      createConveneSource({
        engineFactory: () => makeEngineFromKind(config.defaults.engine),
        db,
        resolvePanel: buildConveneResolver(topic, true),
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
    expertMemory: createExpertMemorySource({
      profileRepo: new ProfileRepository(db),
      documentRepo: new DocumentRepository(db),
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
    chat: createChatSessionSource({ chat: new ChatRepository(db) }),
    chats: createChatsDataSource({ chat: new ChatRepository(db) }),
    chatEngine: createChatEngineSource({
      engineFactory: () => makeEngineFromKind(config.defaults.engine),
      buildSpec: async (slug) => {
        const expert = await expertLibrary.get(slug);
        if (expert === null) {
          throw new Error(`Expert "${slug}" not found`);
        }
        const profile =
          expert.kind === "persona"
            ? ((await profileRepo.findBySlug(slug)) ?? undefined)
            : undefined;
        let memberships: readonly PanelMembership[] = [];
        try {
          memberships = await getExpertPanelMemberships(expert.slug, db);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`Could not load panel memberships for cross-panel context: ${message}`);
        }
        return buildExpertSpec(expert, config, CHAT_TASK_DESCRIPTION, profile, memberships);
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
