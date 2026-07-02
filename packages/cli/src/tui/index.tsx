import path from "node:path";
import { ulid } from "ulid";
import React, { useEffect, useState } from "react";
import { render } from "ink";

import packageJson from "../../package.json" with { type: "json" };
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
import { loadTranscript, type TranscriptDocument } from "../memory/transcript.js";
import { loadConfigWithMeta, updateConfigField, updateConfigFields } from "../config/loader.js";
import type { ConfigLoadResult } from "../config/loader.js";
import { discoverAvailableModels } from "../engine/copilot/health.js";
import { createExpertAuthoringSource } from "./adapters/expert-authoring.js";
import { createExpertDocumentsSource } from "./adapters/expert-documents.js";
import { createExpertMemorySource } from "./adapters/expert-memory.js";
import { createExpertsDataSource } from "./adapters/experts-data.js";
import { createPanelAuthoringSource } from "./adapters/panel-authoring.js";
import { createPanelComposeSource } from "./adapters/panel-compose.js";
import { createPanelsDataSource } from "./adapters/panels-data.js";
import { createSettingsDataSource } from "./adapters/config-settings.js";
import { createSessionsDataSource } from "./adapters/sessions-data.js";
import { createConcludeSource } from "./adapters/conclude.js";
import { createOnboardingSource } from "./adapters/onboarding.js";
import { createExportSource } from "./adapters/export-view.js";
import { renderAdr, renderJson, renderMarkdown } from "../cli/commands/export.js";
import { renderShare } from "../cli/commands/export-share.js";
import {
  createConveneSource,
  type ConveneDataSource,
  type ResolvedConvenePanel,
} from "./adapters/convene.js";
import {
  buildConveneSessionConfigJson,
  createConvenePanelResolver,
  type ConvenePanelRuntimeInput,
} from "./adapters/convene-resolve.js";
import { createExpertTrainingSource, stageDocumentFiles } from "./adapters/expert-training.js";
import { createChatSessionSource } from "./adapters/chat-session.js";
import { createChatsDataSource } from "./adapters/chats-data.js";
import { createChatEngineSource } from "./adapters/chat-engine-session.js";
import { makeEngineFromKind } from "../cli/run-with-engine.js";
import { maybeNotifyUpdate } from "../core/version/index.js";
import { buildExpertSpec, CHAT_TASK_DESCRIPTION } from "../cli/commands/chat/shared.js";
import { getExpertPanelMemberships } from "../core/panel-membership-query.js";
import type { PanelMembership } from "../core/prompt-builder.js";
import { createHomeDataSources } from "./adapters/home-data-sources.js";
import { loadHomeData } from "./adapters/home-data.js";
import { selectStartupWarnings, type StartupWarning } from "./lib/startup-warnings.js";
import { createTuiErrorHandler } from "./lib/error-handler.js";
import { writeFileExclusive } from "./lib/safe-write.js";
import { createTelemetry } from "./lib/telemetry.js";
import { createFileCounterStore, telemetryCountersPath } from "./lib/telemetry-store.js";
import { DataProvider, type TuiDataSources } from "./components/DataProvider.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { CouncilTUI } from "./CouncilTUI.js";
import { runTuiSessions } from "./run-sessions.js";

/**
 * Wrap a transcript loader for the export overlay so a genuinely-absent
 * transcript (the loader resolves `null`/`undefined`) renders as the honest
 * "No transcript" empty state, while an UNEXPECTED load failure (the loader
 * throws — e.g. a missing/corrupt DB or a query bug) propagates so the overlay
 * surfaces a real error state.
 *
 * The previous wiring wrapped the raw loader in `try { … } catch { return null }`,
 * which converted every failure into `null` and masked real errors as an empty
 * "No transcript" state, indistinguishable from a genuinely-absent transcript
 * (Sentinel #1694 §2). Surfacing the actual error also gives the actionable
 * messages `loadTranscript` already throws (e.g. "…has no debates yet").
 */
export function createExportTranscriptLoader(
  load: (panelName: string, debateId?: string) => Promise<TranscriptDocument | null>,
): (panelName: string, debateId?: string) => Promise<TranscriptDocument | null> {
  return async (panelName, debateId) => {
    const doc = await load(panelName, debateId);
    return doc ?? null;
  };
}

/**
 * A reactive sink that routes best-effort runtime warnings into the TUI's
 * dismissible notice banner. The panels degraded-template loader (#2046) — and
 * any future best-effort surface — pushes here via its `onWarning` callback so a
 * warning reaches the alternate-screen TUI instead of `console.warn`/stderr,
 * which is invisible and corrupts it (#2111).
 */
export interface RuntimeWarningChannel {
  /** Best-effort warning sink; safe to wire directly to a data source's `onWarning`. */
  readonly onWarning: (message: string) => void;
  /** Subscribe to accumulation changes; returns an unsubscribe callback. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Snapshot of the accumulated, sanitized warnings. */
  readonly snapshot: () => readonly StartupWarning[];
}

/**
 * Build a {@link RuntimeWarningChannel}. Every message is sanitized and collapsed
 * to a single line via {@link selectStartupWarnings} (shared with the startup
 * notices), and a message that is blank once sanitized is dropped so the banner
 * never renders an empty row. The sink never throws, so a warning can never break
 * the caller's control flow.
 */
export function createRuntimeWarningChannel(): RuntimeWarningChannel {
  const warnings: StartupWarning[] = [];
  const listeners = new Set<() => void>();
  return {
    onWarning: (message: string): void => {
      const [warning] = selectStartupWarnings({ warnings: [message] });
      if (warning === undefined) return;
      warnings.push(warning);
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    snapshot: (): readonly StartupWarning[] => [...warnings],
  };
}

/**
 * Subscribe a component to a {@link RuntimeWarningChannel} so warnings surfaced
 * after mount re-render into the banner. Returns the accumulated warnings.
 */
export function useRuntimeWarnings(channel: RuntimeWarningChannel): readonly StartupWarning[] {
  const [warnings, setWarnings] = useState<readonly StartupWarning[]>(channel.snapshot);
  useEffect(() => channel.subscribe(() => setWarnings(channel.snapshot())), [channel]);
  return warnings;
}

/**
 * Upper bound (ms) on the best-effort shutdown teardown after a *synchronous*
 * startup crash. Sized to let a healthy counter flush + `db.destroy()` finish
 * comfortably, while still capping a teardown that hangs (e.g. a wedged SQLite
 * handle) so a crash can never be swallowed by an unbounded wait.
 */
const STARTUP_CRASH_CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Run `cleanup` but never wait longer than `timeoutMs`. Resolves `true` when
 * cleanup settles (resolves OR rejects — either way it did not hang) within the
 * budget, or `false` when the timeout fires first. Never rejects: a cleanup
 * failure is contained so it cannot mask the crash that triggered the shutdown.
 */
async function runBoundedCleanup(
  cleanup: () => Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(cleanup)
        .then(
          () => true,
          () => true,
        ),
      timedOut,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Drive the TUI to completion, then tear down shared resources (`shutdown`).
 *
 * On a normal exit the teardown runs UNBOUNDED — a full WAL merge matters more
 * than shutdown latency, and the Ink event loop has already unwound cleanly.
 *
 * A *synchronous* startup crash, however, never handed control to the Ink event
 * loop (unlike a render-time crash, which routes through
 * {@link createTuiErrorHandler}), so nothing else is draining the process: a
 * hanging `db.destroy()` in the teardown would wedge the process and swallow the
 * crash entirely. On that path the teardown is bounded by `crashCleanupTimeoutMs`
 * and the crash is always re-thrown, so the failure surfaces even if cleanup
 * hangs (#1844).
 */
export async function runTuiWithBoundedShutdown(
  run: () => Promise<void>,
  shutdown: () => Promise<void>,
  crashCleanupTimeoutMs: number,
): Promise<void> {
  let crash: unknown;
  let crashed = false;
  try {
    await run();
  } catch (error) {
    crash = error;
    crashed = true;
  }
  if (crashed) {
    await runBoundedCleanup(shutdown, crashCleanupTimeoutMs);
    throw crash;
  }
  await shutdown();
}

export async function launchTui(): Promise<void> {
  const dbPath = path.join(getCouncilHome(), "council.db");
  const db = await createDatabase(dbPath);

  // LOCAL, content-free telemetry counter store. Built once per process so
  // content-free counters accumulate across in-process session restarts (e.g.
  // after first-run onboarding). Persisted on shutdown; only ever written when
  // telemetry is enabled and something was actually recorded.
  const counterStore = await createFileCounterStore(telemetryCountersPath(getCouncilHome()));

  // Render one TUI session from a freshly-loaded config snapshot. Re-invoked by
  // runTuiSessions after first-run onboarding so the chosen default model
  // (persisted to config.yaml) is rebuilt into the live session.
  const renderSession = async ({ config, isFirstRun }: ConfigLoadResult): Promise<boolean> => {
    const dataHome = getCouncilDataHome(config);

    // Gate the LOCAL telemetry sink on the opt-in flag (off by default). When
    // disabled, `record` is a strict no-op and nothing is ever written.
    const telemetry = createTelemetry({
      enabled: config.telemetry.enabled,
      store: counterStore,
    });

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
          configJson: buildConveneSessionConfigJson({
            panelName: input.panelName,
            mode: input.mode,
            maxRounds: input.debateConfig.maxRounds,
            maxWords: input.debateConfig.maxWordsPerResponse,
            engine: config.defaults.engine,
            definition: input.definition,
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
        getExpertDefinition: async (slug) => {
          const definition = await expertLibrary.get(slug);
          if (definition === null) {
            throw new Error(`Panel references missing expert "${slug}"`);
          }
          return definition;
        },
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
    // Route the panels degraded-template loader's best-effort warnings (#2046)
    // into the TUI's dismissible notice banner (#2111) instead of console.warn/
    // stderr, which is invisible — and corrupts — the alternate screen.
    const warningChannel = createRuntimeWarningChannel();
    const dataSources: TuiDataSources = {
      panels: createPanelsDataSource({
        library: panelLibrary,
        experts: expertLibrary,
        listTemplates,
        loadTemplate,
        onWarning: warningChannel.onWarning,
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
      conclude: createConcludeSource({
        engineFactory: () => makeEngineFromKind(config.defaults.engine),
        loadTranscript: (panelName: string, debateId?: string) =>
          loadTranscript(db, panelName, debateId),
        model: config.defaults.model ?? DEFAULT_MODEL,
        maxTranscriptChars: config.conclude.maxTranscriptChars,
      }),
      export: {
        ...createExportSource({
          loadTranscript: createExportTranscriptLoader((panelName: string, debateId?: string) =>
            loadTranscript(db, panelName, debateId),
          ),
          renderMarkdown,
          renderJson,
          renderAdr,
          renderShare,
        }),
        writeFile: writeFileExclusive,
      },
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
      onboarding: createOnboardingSource({
        isFirstRun,
        discoverModels: discoverAvailableModels,
        updateConfig: updateConfigField,
      }),
      telemetry,
    };
    const model = config.defaults.model;

    // Surface the throttled "update available" notice in the TUI's startup banner
    // instead of writing it to stderr (which would corrupt the alternate screen).
    // Config-load warnings flow through the same helper once loadConfigWithMeta
    // surfaces them.
    let updateNotice: string | undefined;
    await maybeNotifyUpdate({
      currentVersion: packageJson.version,
      isTTY: process.stdout.isTTY === true,
      write: (notice) => {
        updateNotice = notice;
      },
    });
    const startupWarnings = selectStartupWarnings(
      updateNotice !== undefined ? { updateNotice } : {},
    );

    let restartRequested = false;
    let unmount: () => void = () => undefined;
    // Crash via process.exit(1) skips the `finally` cleanup (counter flush +
    // db.destroy); instead signal the Ink app to exit so waitUntilExit resolves
    // and cleanup runs before the process drains. Exit code is preserved.
    const handleTuiError = createTuiErrorHandler({ signalExit: () => unmount() });
    // Merge the static startup notices with any runtime warnings pushed through
    // `warningChannel` (e.g. the degraded-template loader) so both surface in the
    // same dismissible banner rather than corrupting the alternate screen (#2111).
    const TuiRoot = (): React.ReactElement => {
      const runtimeWarnings = useRuntimeWarnings(warningChannel);
      return (
        <ErrorBoundary onError={handleTuiError}>
          <DataProvider value={dataSources}>
            <CouncilTUI
              homeData={homeData}
              model={model}
              startupWarnings={[...startupWarnings, ...runtimeWarnings]}
              isFirstRun={isFirstRun}
              onOnboardingComplete={() => {
                restartRequested = true;
                unmount();
              }}
            />
          </DataProvider>
        </ErrorBoundary>
      );
    };
    const instance = render(<TuiRoot />, {
      alternateScreen: true,
      incrementalRendering: true,
    });
    unmount = instance.unmount;

    await instance.waitUntilExit();
    return restartRequested;
  };

  const shutdown = async (): Promise<void> => {
    // Best-effort persist of the local content-free counters; a flush failure
    // must never affect the CLI's outcome or block shutdown.
    await counterStore.flush().catch(() => undefined);
    await db.destroy();
  };

  // Normal exit: full, unbounded teardown. Synchronous startup crash: teardown
  // is timeout-bounded so a hanging db.destroy() cannot wedge the process and
  // swallow the crash (#1844).
  await runTuiWithBoundedShutdown(
    () => runTuiSessions({ loadConfigWithMeta, renderSession }),
    shutdown,
    STARTUP_CRASH_CLEANUP_TIMEOUT_MS,
  );
}
