/**
 * 1:1 expert chat REPL loop — `council chat <expert-slug>`.
 */
import {
  CHAT_TASK_DESCRIPTION,
  isExitCommand,
  getStartupHelpText,
  buildChatTurnPrompt,
  appendReferenceDocuments,
  safeRetrieveSnippets,
  safeGetContext,
  seedLongConversationCount,
  maybeWarnLongConversation,
  warnIfBackgroundProcessingEnabled,
  createSummarizationGate,
  rewriteRotateError,
  buildExpertSpec,
  maybeProcessPersonaDocs,
  makeSink,
  defaultInputProvider,
  defaultSubscribeInterrupt,
  formatDate,
  ChatRepository,
  createChatRenderer,
  createDocumentRetriever,
  buildExpertRetrievalScopes,
  createContextManager,
  formatEngineError,
  makeEngineFromKind,
  checkTopicAdmission,
  getExpertPanelMemberships,
  type ChatCommandDeps,
  type ChatRunOptions,
  type ChatInputProvider,
  type ChatSession,
  type ExpertDefinition,
  type CouncilConfig,
  type CouncilEngine,
  type CouncilDatabase,
  type ExpertSpec,
  type EngineKind,
  type Writer,
  type PanelMembership,
  type ChatRenderer,
} from "./shared.js";

interface ExpertChatOptions {
  readonly target: string;
  readonly expert: ExpertDefinition;
  readonly raw: ChatRunOptions;
  readonly deps: ChatCommandDeps;
  readonly write: Writer;
  readonly writeError: Writer;
  readonly config: CouncilConfig;
  readonly db: CouncilDatabase;
  readonly engineKind: EngineKind;
  readonly dataHome: string;
}

export async function runExpertChat(opts: ExpertChatOptions): Promise<void> {
  const { target, expert, raw, deps, writeError, config, db, engineKind, dataHome } = opts;
  const repo = new ChatRepository(db);

  const existingActive = await repo.findActiveSession("expert", target);
  let priorToArchive: ChatSession | undefined;
  let resumingSession: ChatSession | undefined;
  let willCreateFresh = false;
  if (raw.new) {
    priorToArchive = existingActive;
    willCreateFresh = true;
  } else if (existingActive) {
    resumingSession = existingActive;
  } else {
    willCreateFresh = true;
  }

  const renderer = createChatRenderer({
    sink: makeSink(opts.write, writeError),
    experts: new Map([[expert.slug, expert.displayName]]),
  });

  warnIfBackgroundProcessingEnabled(config, renderer);

  const engine = deps.engineFactory ? deps.engineFactory() : makeEngineFromKind(engineKind);
  const inputProvider = (deps.inputProvider ?? defaultInputProvider)();

  try {
    await engine.start();

    const personaProfile = await maybeProcessPersonaDocs({
      expert,
      dataHome,
      db,
      engine,
      config,
      renderer,
    });

    let panelMemberships: readonly PanelMembership[] = [];
    try {
      panelMemberships = await getExpertPanelMemberships(expert.slug, db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      renderer.showSystem(
        `Could not load panel memberships for cross-panel context: ${msg}`,
        "warn",
      );
    }

    const expertSpec = buildExpertSpec(
      expert,
      config,
      CHAT_TASK_DESCRIPTION,
      personaProfile,
      panelMemberships,
    );
    await engine.addExpert(expertSpec);

    let session: ChatSession;
    if (raw.new && priorToArchive) {
      try {
        session = await repo.rotateActiveSession(
          { targetType: "expert", targetSlug: target },
          { priorActiveId: priorToArchive.id },
        );
      } catch (err) {
        throw rewriteRotateError(err);
      }
      renderer.showSystem("Previous conversation archived. Starting fresh...", "info");
      renderer.showSessionStatus(`Starting new conversation with ${expert.displayName}...`);
    } else if (willCreateFresh) {
      session = await repo.createSession({ targetType: "expert", targetSlug: target });
      renderer.showSessionStatus(`Starting 1:1 chat with ${expert.displayName}`);
    } else if (resumingSession) {
      session = resumingSession;
      const existingCount = await repo.getTurnCount(session.id);
      renderer.showSessionStatus(
        `Resuming conversation with ${expert.displayName} (${existingCount} messages, last active ${formatDate(session.updatedAt)})...`,
      );
    } else {
      throw new Error("internal: chat session resolution failed");
    }

    // Show startup help text
    renderer.showSystem(getStartupHelpText(), "info");

    await runInteractiveLoop({
      engine,
      expertSpec,
      expert,
      session,
      repo,
      renderer,
      inputProvider,
      config,
      writeError,
      db,
      target,
      panelMemberships,
      subscribeInterrupt: deps.subscribeInterrupt ?? defaultSubscribeInterrupt,
    });
  } catch (err: unknown) {
    writeError("\n" + formatEngineError(err as Error) + "\n\n");
    throw err;
  } finally {
    inputProvider.close();
    await engine.stop().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      writeError(`!! engine.stop() failed during cleanup: ${msg}\n`);
    });
  }
}

interface InteractiveLoopOptions {
  readonly engine: CouncilEngine;
  readonly expertSpec: ExpertSpec;
  readonly expert: ExpertDefinition;
  readonly session: ChatSession;
  readonly repo: ChatRepository;
  readonly renderer: ChatRenderer;
  readonly inputProvider: ChatInputProvider;
  readonly config: CouncilConfig;
  readonly writeError: Writer;
  readonly db: CouncilDatabase;
  readonly target: string;
  readonly panelMemberships: readonly PanelMembership[];
  readonly subscribeInterrupt: (handler: () => void) => () => void;
}

async function runInteractiveLoop(opts: InteractiveLoopOptions): Promise<void> {
  const {
    engine,
    expertSpec,
    expert,
    session,
    repo,
    renderer,
    inputProvider,
    config,
    writeError,
    target,
    panelMemberships,
    subscribeInterrupt,
  } = opts;

  const retriever = createDocumentRetriever(opts.db);
  const contextMgr = createContextManager(repo, engine, {
    recentTurnCount: config.chat.recentTurnCount,
    summaryMaxWords: config.chat.summaryMaxWords,
    model: expertSpec.model,
  });

  let prevTurnCount = await seedLongConversationCount(repo, session.id, renderer);

  const summarizationGate = createSummarizationGate(contextMgr, (msg) =>
    renderer.showSystem(msg, "warn"),
  );

  type LoopState =
    | { readonly kind: "idle" }
    | { readonly kind: "prompt" }
    | { readonly kind: "streaming"; readonly controller: AbortController };
  let state: LoopState = { kind: "idle" };
  let interruptedAtPrompt = false;
  let interruptedDuringStream = false;
  const onInterrupt = (): void => {
    if (state.kind === "streaming") {
      interruptedDuringStream = true;
      state.controller.abort();
    } else if (state.kind === "prompt") {
      interruptedAtPrompt = true;
      inputProvider.close();
    }
  };
  const unsubscribeInterrupt = subscribeInterrupt(onInterrupt);

  try {
    while (true) {
      renderer.showPrompt();
      state = { kind: "prompt" };
      const line = await inputProvider.readLine();
      state = { kind: "idle" };
      if (interruptedAtPrompt) {
        renderer.showSystem(`Conversation saved. Resume with "council chat ${target}".`, "info");
        return;
      }
      if (line === null) {
        renderer.showSystem("Conversation saved.", "info");
        return;
      }
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      if (isExitCommand(trimmed)) {
        renderer.showSystem("Conversation saved.", "info");
        return;
      }

      const admission = checkTopicAdmission(trimmed);
      for (const warning of admission.warnings) {
        renderer.showSystem(warning, "warn");
      }

      await repo.addTurn({ chatId: session.id, role: "user", content: trimmed });
      prevTurnCount = await maybeWarnLongConversation(
        repo,
        session.id,
        config,
        renderer,
        prevTurnCount,
      );

      await summarizationGate.awaitIfSettled();

      const context = await safeGetContext(contextMgr, session.id, (msg) =>
        renderer.showSystem(msg, "warn"),
      );
      const history =
        context.recentTurns.length > 0 ? context.recentTurns.slice(0, -1) : context.recentTurns;

      const snippets = await safeRetrieveSnippets(
        retriever,
        trimmed,
        {
          // T1 RAG: an expert in a 1:1 chat also sees the documents of every
          // panel it belongs to — not just its own expert-scoped docs — so
          // panel knowledge surfaces when talking to a member directly.
          scopes: buildExpertRetrievalScopes(
            expert.slug,
            panelMemberships.map((m) => m.panelName),
          ),
          maxResults: 5,
        },
        (msg) => renderer.showSystem(msg, "warn"),
      );
      const userMessageWithRefs = appendReferenceDocuments(trimmed, snippets, (info) =>
        renderer.showSystem(
          `Neutralized ${info.count} potential prompt-injection marker${
            info.count === 1 ? "" : "s"
          } in reference document "${info.source}".`,
          "warn",
        ),
      );

      const prompt = buildChatTurnPrompt({
        history,
        userMessage: userMessageWithRefs,
        expertDisplayName: expert.displayName,
        summary: context.summary,
      });

      let assembled = "";
      let failed = false;
      let recoverable = false;
      let lastError = "";
      const attempt = async (): Promise<void> => {
        assembled = "";
        failed = false;
        recoverable = false;
        lastError = "";
        const controller = new AbortController();
        state = { kind: "streaming", controller };
        try {
          for await (const evt of engine.send({
            prompt,
            expertId: expertSpec.id,
            signal: controller.signal,
          })) {
            if (evt.kind === "message.delta") {
              assembled += evt.text;
            } else if (evt.kind === "error") {
              failed = true;
              recoverable = evt.recoverable;
              lastError = evt.error.message;
            }
          }
        } catch (err: unknown) {
          failed = true;
          recoverable = false;
          lastError = err instanceof Error ? err.message : String(err);
        } finally {
          state = { kind: "idle" };
        }
      };

      interruptedDuringStream = false;
      await attempt();
      if (!interruptedDuringStream && failed && recoverable) {
        renderer.showSystem("Transient error from engine. Retrying once...", "warn");
        await attempt();
      }

      if (interruptedDuringStream) {
        if (assembled.length > 0) {
          await repo.addTurn({
            chatId: session.id,
            role: "expert",
            expertSlug: expert.slug,
            content: assembled,
          });
        }
        renderer.showSystem("Response interrupted. Partial response saved.", "info");
        continue;
      }

      if (!failed && assembled.length > 0) {
        renderer.startExpertResponse(expert.slug);
        renderer.streamChunk(assembled);
        renderer.endExpertResponse();
      }

      if (failed) {
        writeError(formatEngineError({ code: "PROVIDER_ERROR", message: lastError }) + "\n");
        renderer.showSystem(
          "Failed to get response. Your message has been saved. Try again.",
          "warn",
        );
        continue;
      }

      if (assembled.length === 0) {
        renderer.showSystem("Empty response from engine. Your message has been saved.", "warn");
        continue;
      }

      await repo.addTurn({
        chatId: session.id,
        role: "expert",
        expertSlug: expert.slug,
        content: assembled,
      });

      prevTurnCount = await maybeWarnLongConversation(
        repo,
        session.id,
        config,
        renderer,
        prevTurnCount,
      );

      summarizationGate.kickOff(session.id);
    }
  } finally {
    await summarizationGate.awaitOutstanding();
    unsubscribeInterrupt();
  }
}
