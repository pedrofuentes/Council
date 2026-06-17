/**
 * Panel (multi-expert) chat REPL loop — `council chat <panel-slug>`.
 */
import * as path from "node:path";

import {
  PANEL_CHAT_TASK_DESCRIPTION,
  isExitCommand,
  getStartupHelpText,
  buildExpertSpec,
  buildPanelTurnPrompt,
  appendReferenceDocuments,
  capSnippetsByChars,
  REFERENCE_DOCS_CHAR_CAP,
  safeRetrieveSnippets,
  safeGetContext,
  seedLongConversationCount,
  maybeWarnLongConversation,
  warnIfBackgroundProcessingEnabled,
  createSummarizationGate,
  rewriteRotateError,
  makeSink,
  defaultInputProvider,
  defaultSubscribeInterrupt,
  formatDate,
  parseUserInput,
  formatExpertRoster,
  resolveExperts,
  ChatRepository,
  createChatRenderer,
  createDocumentRetriever,
  createContextManager,
  formatEngineError,
  makeEngineFromKind,
  collectSendWithEmptyRetry,
  isEmptyResponse,
  checkTopicAdmission,
  Debate,
  PersistTurnPairError,
  CliUserError,
  DEFAULT_MODEL,
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
  type PanelDefinition,
  type ChatRenderer,
  type ParsedInput,
  type DocumentSnippet,
} from "./shared.js";
import type { FileExpertLibrary } from "./shared.js";

interface PanelChatOptions {
  readonly target: string;
  readonly panel: PanelDefinition;
  readonly library: FileExpertLibrary;
  readonly raw: ChatRunOptions;
  readonly deps: ChatCommandDeps;
  readonly write: Writer;
  readonly writeError: Writer;
  readonly config: CouncilConfig;
  readonly db: CouncilDatabase;
  readonly engineKind: EngineKind;
  readonly dataHome: string;
}

interface PanelMember {
  readonly expert: ExpertDefinition;
  readonly spec: ExpertSpec;
}

export async function runPanelChat(opts: PanelChatOptions): Promise<void> {
  const { target, panel, library, raw, deps, write, writeError, config, db, engineKind, dataHome } =
    opts;

  const { resolved, missing } = await resolveExperts(panel.experts, library);
  if (missing.length > 0) {
    const total = panel.experts.length;
    const remaining = resolved.length;
    for (const slug of missing) {
      writeError(`⚠ Expert "${slug}" not found in library.\n`);
    }
    writeError(`Continuing with ${remaining} of ${total} experts.\n`);
  }
  if (resolved.length === 0) {
    writeError(`Panel "${target}" has no available experts.\n`);
    throw new CliUserError(`Panel "${target}" has no available experts`);
  }

  const repo = new ChatRepository(db);

  const existingActive = await repo.findActiveSession("panel", target);
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

  const expertNames = new Map<string, string>();
  for (const e of resolved) expertNames.set(e.slug, e.displayName);

  const renderer = createChatRenderer({
    sink: makeSink(write, writeError),
    experts: expertNames,
  });

  warnIfBackgroundProcessingEnabled(config, renderer);

  const engine = deps.engineFactory ? deps.engineFactory() : makeEngineFromKind(engineKind);
  const inputProvider = (deps.inputProvider ?? defaultInputProvider)();

  try {
    await engine.start();
    const members: PanelMember[] = [];
    for (const expert of resolved) {
      const spec = buildExpertSpec(expert, config, PANEL_CHAT_TASK_DESCRIPTION);
      await engine.addExpert(spec);
      members.push({ expert, spec });
    }

    // Refresh the panel's RAG corpus before any turns run so retrieval
    // sees the latest on-disk state. Failures are logged but not fatal.
    try {
      const { scanAndIndexPanelDocuments, formatAllFailedWarning } =
        await import("../../../core/documents/panel-document-scanner.js");
      const { renderScanLines } = await import(
        "../../../cli/formatters/scan-summary.js"
      );
      const managedDocsDir = path.join(dataHome, "panels", target, "docs");
      const result = await scanAndIndexPanelDocuments({
        panelName: target,
        managedDocsDir,
        db,
        supportedFormats: config.expert.supportedFormats,
        maxFileSizeBytes: config.documents.maxFileSizeMB * 1024 * 1024,
        aiFallback: {
          mode: config.documents.aiExtraction,
          allowedExtensions: config.documents.aiExtractionAllowedExtensions,
        },
      });
      if (
        result.indexed > 0 ||
        result.failed > 0 ||
        result.unchanged > 0 ||
        result.needsReview > 0
      ) {
        renderScanLines(renderer, {
          indexed: result.indexed,
          modified: 0,
          unchanged: result.unchanged,
          failed: result.failed,
          needsReview: result.needsReview,
          files: result.files,
          maxFileSizeMB: config.documents.maxFileSizeMB,
        });
      }
      const allFailedWarning = formatAllFailedWarning(result);
      if (allFailedWarning !== null) {
        renderer.showSystem(allFailedWarning, "warn");
      }
      if (result.foldersFailed > 0) {
        const linkedFailed = result.foldersFailed - (result.managedFolderFailed ? 1 : 0);
        const parts: string[] = [];
        if (result.managedFolderFailed) parts.push("the managed docs folder");
        if (linkedFailed > 0) {
          parts.push(`${linkedFailed} linked folder(s)`);
        }
        const what = parts.join(" and ");
        renderer.showSystem(
          `Could not scan ${what} — run \`council panel docs list <name>\` to review.`,
          "warn",
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      renderer.showSystem(`Panel document scan failed (continuing): ${msg}`, "warn");
    }

    let session: ChatSession;
    if (raw.new && priorToArchive) {
      try {
        session = await repo.rotateActiveSession(
          { targetType: "panel", targetSlug: target },
          { priorActiveId: priorToArchive.id },
        );
      } catch (err) {
        throw rewriteRotateError(err);
      }
      renderer.showSystem("Previous conversation archived. Starting fresh...", "info");
      const names = resolved.map((e) => e.displayName).join(", ");
      renderer.showSessionStatus(
        `Starting panel chat with ${panel.name} (${resolved.length} experts: ${names})...`,
      );
    } else if (willCreateFresh) {
      session = await repo.createSession({ targetType: "panel", targetSlug: target });
      renderer.showSessionStatus(
        `Starting group chat with ${panel.name} (${resolved.length} experts) — use @<slug> to address specific experts`,
      );
    } else if (resumingSession) {
      session = resumingSession;
      const existingCount = await repo.getTurnCount(session.id);
      renderer.showSessionStatus(
        `Resuming panel chat with ${panel.name} (${existingCount} messages, last active ${formatDate(session.updatedAt)})...`,
      );
    } else {
      throw new Error("internal: panel chat session resolution failed");
    }

    // Show the addressable expert roster so users know exactly which
    // slugs to @mention, then the general startup help text.
    const rosterLine = formatExpertRoster(resolved.map((e) => e.slug));
    if (rosterLine.length > 0) {
      renderer.showSystem(rosterLine, "info");
    }
    renderer.showSystem(getStartupHelpText(), "info");

    await runPanelInteractiveLoop({
      engine,
      members,
      expertNames,
      session,
      repo,
      renderer,
      inputProvider,
      config,
      writeError,
      db,
      panelName: target,
      target,
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

interface PanelInteractiveLoopOptions {
  readonly engine: CouncilEngine;
  readonly members: readonly PanelMember[];
  readonly expertNames: ReadonlyMap<string, string>;
  readonly session: ChatSession;
  readonly repo: ChatRepository;
  readonly renderer: ChatRenderer;
  readonly inputProvider: ChatInputProvider;
  readonly config: CouncilConfig;
  readonly writeError: Writer;
  readonly db: CouncilDatabase;
  readonly panelName: string;
  readonly target: string;
  readonly subscribeInterrupt: (handler: () => void) => () => void;
}

async function runPanelInteractiveLoop(opts: PanelInteractiveLoopOptions): Promise<void> {
  const {
    engine,
    members,
    expertNames,
    session,
    repo,
    renderer,
    inputProvider,
    config,
    writeError,
    db,
    panelName,
    target,
    subscribeInterrupt,
  } = opts;

  const retriever = createDocumentRetriever(db);
  const summarizerModel = members[0]?.spec.model ?? config.defaults.model ?? DEFAULT_MODEL;
  const contextMgr = createContextManager(repo, engine, {
    recentTurnCount: config.chat.recentTurnCount,
    summaryMaxWords: config.chat.summaryMaxWords,
    model: summarizerModel,
  });

  let prevTurnCount = await seedLongConversationCount(repo, session.id, renderer);

  const summarizationGate = createSummarizationGate(contextMgr, (msg) =>
    renderer.showSystem(msg, "warn"),
  );

  type LoopState =
    | { readonly kind: "idle" }
    | { readonly kind: "prompt" }
    | { readonly kind: "streaming"; readonly controller: AbortController }
    | { readonly kind: "debate"; readonly controller: AbortController };
  let state: LoopState = { kind: "idle" };
  let interruptedAtPrompt = false;
  let interruptedDuringStream = false;
  const onInterrupt = (): void => {
    if (state.kind === "streaming") {
      interruptedDuringStream = true;
      state.controller.abort();
    } else if (state.kind === "debate") {
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
      if (trimmed.length === 0) continue;
      if (isExitCommand(trimmed)) {
        renderer.showSystem("Conversation saved.", "info");
        return;
      }

      const panelSlugs = members.map((m) => m.expert.slug);
      let parsed: ParsedInput;
      try {
        parsed = parseUserInput(trimmed, panelSlugs);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        writeError(msg + "\n");
        continue;
      }

      if (parsed.type === "convene") {
        const admission = checkTopicAdmission(parsed.content);
        for (const warning of admission.warnings) {
          renderer.showSystem(warning, "warn");
        }
        // T1 RAG: surface the panel's indexed documents to the inline
        // structured debate too, mirroring the per-turn panel-chat retrieval
        // below. Best-effort and capped to the shared char budget.
        const conveneSnippets = await safeRetrieveSnippets(
          retriever,
          parsed.content,
          { panelName, maxResults: 5 },
          (msg) => renderer.showSystem(msg, "warn"),
        );
        const conveneReferenceDocs = capSnippetsByChars(
          conveneSnippets,
          REFERENCE_DOCS_CHAR_CAP,
        );
        const debateController = new AbortController();
        state = { kind: "debate", controller: debateController };
        try {
          await runInlineDebate({
            engine,
            members,
            session,
            repo,
            renderer,
            topic: parsed.content,
            writeError,
            signal: debateController.signal,
            ...(conveneReferenceDocs.length > 0
              ? { referenceDocuments: conveneReferenceDocs }
              : {}),
          });
        } finally {
          state = { kind: "idle" };
        }
        continue;
      }

      const isMention = parsed.type === "mention";
      const respondingMembers: readonly PanelMember[] = isMention
        ? members.filter((m) => parsed.targetSlugs.includes(m.expert.slug))
        : members;

      await repo.addTurn({
        chatId: session.id,
        role: "user",
        content: parsed.content,
        isMention,
      });
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
        parsed.content,
        { panelName, maxResults: 5 },
        (msg) => renderer.showSystem(msg, "warn"),
      );
      const userMessageWithRefs = appendReferenceDocuments(parsed.content, snippets, (info) =>
        renderer.showSystem(
          `Neutralized ${info.count} potential prompt-injection marker${
            info.count === 1 ? "" : "s"
          } in reference document "${info.source}".`,
          "warn",
        ),
      );

      const errorExperts: string[] = [];
      const emptyExperts: string[] = [];
      let succeeded = 0;

      const prompt = buildPanelTurnPrompt({
        history,
        userMessage: userMessageWithRefs,
        expertNames,
        summary: context.summary,
      });

      let interruptedThisTurn = false;
      for (const { expert, spec } of respondingMembers) {
        if (interruptedThisTurn) break;
        let assembled = "";
        let failed = false;
        let recoverable = false;
        let lastError = "";
        // T14: true when the response was still empty after the helper's one
        // automatic retry, so the empty warning can say a retry was tried.
        let emptyAfterRetry = false;
        const attempt = async (): Promise<void> => {
          assembled = "";
          failed = false;
          recoverable = false;
          lastError = "";
          emptyAfterRetry = false;
          const controller = new AbortController();
          state = { kind: "streaming", controller };
          try {
            // collectSendWithEmptyRetry reissues the same send ONCE when the
            // first response completes empty/whitespace-only and was not
            // failed/aborted. The single AbortController covers both the
            // initial send and the retry, so an interrupt cancels either.
            const outcome = await collectSendWithEmptyRetry(engine, {
              prompt,
              expertId: spec.id,
              signal: controller.signal,
            });
            assembled = outcome.content;
            failed = outcome.failed;
            recoverable = outcome.recoverable;
            lastError = outcome.errorMessage;
            emptyAfterRetry = outcome.emptyAfterRetry;
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
          renderer.showSystem(
            `Transient error from ${expert.displayName}. Retrying once...`,
            "warn",
          );
          await attempt();
        }

        if (interruptedDuringStream) {
          if (assembled.length > 0) {
            await repo.addTurn({
              chatId: session.id,
              role: "expert",
              expertSlug: expert.slug,
              content: assembled,
              isMention,
            });
          }
          renderer.showSystem("Response interrupted. Partial response saved.", "info");
          interruptedThisTurn = true;
          continue;
        }

        if (!failed && !isEmptyResponse(assembled)) {
          renderer.startExpertResponse(expert.slug);
          renderer.streamChunk(assembled);
          renderer.endExpertResponse();
          await repo.addTurn({
            chatId: session.id,
            role: "expert",
            expertSlug: expert.slug,
            content: assembled,
            isMention,
          });
          prevTurnCount = await maybeWarnLongConversation(
            repo,
            session.id,
            config,
            renderer,
            prevTurnCount,
          );
          succeeded += 1;
          continue;
        }

        if (failed) {
          writeError(formatEngineError({ code: "PROVIDER_ERROR", message: lastError }) + "\n");
          errorExperts.push(expert.displayName);
          continue;
        }

        emptyExperts.push(expert.displayName);
        renderer.showSystem(
          emptyAfterRetry
            ? `${expert.displayName} returned an empty response after a retry.`
            : `${expert.displayName} returned an empty response.`,
          "warn",
        );
      }

      if (interruptedThisTurn) {
        continue;
      }

      const total = respondingMembers.length;
      if (succeeded === 0) {
        if (errorExperts.length > 0 && emptyExperts.length === 0) {
          renderer.showSystem(
            "No experts could respond. Check your connection and try again.",
            "warn",
          );
        } else if (errorExperts.length === 0 && emptyExperts.length > 0) {
          renderer.showSystem(`All ${total} experts returned empty responses.`, "warn");
        } else {
          renderer.showSystem(
            `${errorExperts.join(", ")} could not respond (engine error); ` +
              `${emptyExperts.join(", ")} returned an empty response. ` +
              `0 of ${total} experts responded.`,
            "warn",
          );
        }
      } else if (errorExperts.length > 0 || emptyExperts.length > 0) {
        const parts: string[] = [];
        if (errorExperts.length > 0) {
          parts.push(`${errorExperts.join(", ")} could not respond (engine error)`);
        }
        if (emptyExperts.length > 0) {
          parts.push(`${emptyExperts.join(", ")} returned an empty response`);
        }
        renderer.showSystem(
          `${parts.join("; ")}. ${succeeded} of ${total} experts responded.`,
          "warn",
        );
      }

      summarizationGate.kickOff(session.id);
    }
  } finally {
    await summarizationGate.awaitOutstanding();
    unsubscribeInterrupt();
  }
}

// ──────────────────────────────────────────────────────────────────────
// @convene — inline structured debate (Roadmap 5.6)
// ──────────────────────────────────────────────────────────────────────

interface InlineDebateOptions {
  readonly engine: CouncilEngine;
  readonly members: readonly PanelMember[];
  readonly session: ChatSession;
  readonly repo: ChatRepository;
  readonly renderer: ChatRenderer;
  readonly topic: string;
  readonly writeError: Writer;
  readonly signal?: AbortSignal;
  /**
   * T1 RAG: retrieved panel documents to inject into every expert turn of
   * the inline structured debate via the shared [REFERENCE DOCUMENTS]
   * block. Omitted/empty leaves the debate prompts untouched.
   */
  readonly referenceDocuments?: readonly DocumentSnippet[];
}

async function runInlineDebate(opts: InlineDebateOptions): Promise<void> {
  const { engine, members, session, repo, renderer, topic, writeError, signal } = opts;

  renderer.showSystem(`⚙ Starting structured deliberation: "${topic}"...`, "info");

  if (signal?.aborted) {
    renderer.showSystem("⚠ Structured deliberation interrupted. Chat mode resumed.", "warn");
    return;
  }

  const debate = new Debate(
    engine,
    members.map((m) => m.spec),
    {
      maxRounds: 1,
      maxWordsPerResponse: 0,
      mode: "structured",
      ...(opts.referenceDocuments !== undefined && opts.referenceDocuments.length > 0
        ? { referenceDocuments: opts.referenceDocuments }
        : {}),
    },
  );

  const originalSpecs: ExpertSpec[] = members.map((m) => m.spec);
  for (const augmented of debate.experts) {
    await engine.removeExpert(augmented.id);
    await engine.addExpert(augmented);
  }

  const phaseCount = members.length === 1 ? 3 : 4;
  const expectedTurns = phaseCount * members.length;

  let userTurnPersisted = false;
  const persistUserTurnOnce = async (): Promise<void> => {
    if (!userTurnPersisted) {
      await repo.addTurn({ chatId: session.id, role: "user", content: topic });
      userTurnPersisted = true;
    }
  };

  let persistedTurns = 0;
  let lastPhase: string | undefined;
  let inTurn = false;
  let buffer = "";
  let bufferSlug: string | undefined;
  let aborted = false;

  const iterator = debate.run(topic, signal ? { signal } : {})[Symbol.asyncIterator]();
  const ABORT_SENTINEL = Symbol("inline-debate-abort");
  let abortListener: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<typeof ABORT_SENTINEL>((resolve) => {
        abortListener = (): void => resolve(ABORT_SENTINEL);
        signal.addEventListener("abort", abortListener, { once: true });
      })
    : undefined;

  try {
    while (true) {
      const next = abortPromise
        ? await Promise.race([iterator.next(), abortPromise])
        : await iterator.next();

      if (next === ABORT_SENTINEL) {
        aborted = true;
        if (inTurn && buffer.length > 0 && bufferSlug !== undefined) {
          const slugBeingFlushed = bufferSlug;
          const lostBytes = buffer.length;
          try {
            if (!userTurnPersisted) {
              await repo.persistTurnPair(
                { chatId: session.id, role: "user", content: topic },
                {
                  chatId: session.id,
                  role: "expert",
                  expertSlug: slugBeingFlushed,
                  content: buffer,
                },
              );
              userTurnPersisted = true;
            } else {
              await repo.addTurn({
                chatId: session.id,
                role: "expert",
                expertSlug: slugBeingFlushed,
                content: buffer,
              });
            }
            persistedTurns += 1;
            buffer = "";
            bufferSlug = undefined;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            const rollbackFailed = err instanceof PersistTurnPairError && err.rollbackFailed;
            renderer.showSystem(
              rollbackFailed
                ? `⚠ Could not persist partial ${slugBeingFlushed} response (${lostBytes} bytes) after interruption AND rollback failed; chat history may be inconsistent — inspect with \`council chat ${session.targetSlug} --history\`: ${msg}`
                : `⚠ Could not persist partial ${slugBeingFlushed} response (${lostBytes} bytes) after interruption: ${msg}`,
              "warn",
            );
          }
        }
        void iterator.return?.(undefined).catch((cleanupErr: unknown) => {
          const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          renderer.showSystem(
            `⚠ Debate generator cleanup after interruption failed: ${msg}`,
            "warn",
          );
        });
        break;
      }

      if (next.done) break;
      const evt = next.value;

      switch (evt.kind) {
        case "round.start":
          if (evt.phase !== undefined) {
            lastPhase = evt.phase;
            renderer.showSystem(`— Phase: ${evt.phase} —`, "info");
          }
          break;
        case "turn.start":
          inTurn = true;
          buffer = "";
          bufferSlug = evt.expertSlug;
          renderer.startExpertResponse(evt.expertSlug);
          break;
        case "turn.delta":
          buffer += evt.text;
          renderer.streamChunk(evt.text);
          break;
        case "turn.end":
          renderer.endExpertResponse();
          if (buffer.length > 0 && bufferSlug !== undefined) {
            await persistUserTurnOnce();
            await repo.addTurn({
              chatId: session.id,
              role: "expert",
              expertSlug: bufferSlug,
              content: buffer,
            });
            persistedTurns += 1;
          }
          inTurn = false;
          buffer = "";
          bufferSlug = undefined;
          break;
        case "error":
          if (inTurn) {
            renderer.endExpertResponse();
            inTurn = false;
            buffer = "";
            bufferSlug = undefined;
          }
          writeError(formatEngineError({ code: "PROVIDER_ERROR", message: evt.message }) + "\n");
          break;
        case "panel.assembled":
        case "round.end":
        case "cost.update":
        case "debate.end":
        case "turn.retry":
          break;
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    writeError(`Structured deliberation failed: ${msg}\n`);
    renderer.showSystem(
      `⚠ Structured deliberation interrupted${lastPhase ? ` during ${lastPhase}` : ""}. Chat mode resumed.`,
      "warn",
    );
    return;
  } finally {
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
    if (inTurn) {
      renderer.endExpertResponse();
    }
    for (const original of originalSpecs) {
      try {
        await engine.removeExpert(original.id);
        await engine.addExpert(original);
      } catch (restoreErr: unknown) {
        const msg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
        writeError(
          `!! failed to restore expert ${original.id} after structured deliberation: ${msg}\n`,
        );
      }
    }
  }

  if (aborted) {
    renderer.showSystem(
      `⚠ Structured deliberation interrupted${lastPhase ? ` during ${lastPhase}` : ""}. Chat mode resumed.`,
      "warn",
    );
    return;
  }

  if (persistedTurns < expectedTurns) {
    renderer.showSystem(
      `⚠ Structured deliberation completed with ${persistedTurns} of ${expectedTurns} turns. Chat mode resumed.`,
      "warn",
    );
    return;
  }

  renderer.showSystem("✓ Structured deliberation complete. Resuming chat mode.", "info");
}
