/**
 * Rolling-summary context manager for chat sessions (Roadmap 5.3).
 *
 * Long chat conversations would otherwise blow past the model's context
 * window. This manager keeps the most recent N turns verbatim and folds
 * everything older into a rolling textual summary stored on the
 * `chat_sessions` row (`summary`, `summary_through_seq`).
 *
 * Algorithm (per TSD §8):
 *   1. If totalTurns <= recentTurnCount → no-op.
 *   2. Otherwise summarize every turn with `seq > summaryThroughSeq` and
 *      `seq <= totalTurns - recentTurnCount`.
 *   3. The prompt to the LLM includes the existing summary (or a "No
 *      prior summary." placeholder) so successive calls produce a single
 *      cumulative summary, not a chain of mini-summaries.
 *
 * Failure semantics: every failure path in `maybeSummarize` is best-effort
 * — the chat continues with the previous summary (or none). LLM /
 * provider errors do NOT propagate to the caller.
 */
import { ulid } from "ulid";

import type { CouncilEngine, EngineEvent, ExpertSpec } from "../../engine/index.js";
import type { ChatRepository } from "../../memory/repositories/chat-repository.js";
import type { ChatTurn } from "./chat-session.js";

export interface ContextManagerConfig {
  readonly recentTurnCount: number;
  readonly summaryMaxWords: number;
  /**
   * Model identifier passed to {@link CouncilEngine.addExpert} for the
   * temporary summarizer expert. Required because `ExpertSpec.model` is
   * non-optional; callers typically pass the panel's default model.
   */
  readonly model: string;
}

export interface ChatContext {
  readonly summary: string | null;
  readonly recentTurns: readonly ChatTurn[];
}

export interface ContextManager {
  /** Get the current context window for a chat session. */
  getContext(chatId: string): Promise<ChatContext>;

  /**
   * Check if summarization is needed and perform it if so. Call after
   * adding new turns. Returns `true` iff a new summary was produced and
   * persisted.
   */
  maybeSummarize(chatId: string): Promise<boolean>;

  /**
   * Force summarization of every turn except the most-recent window.
   * Resolves silently if no turns exist or if the LLM call fails.
   */
  forceSummarize(chatId: string): Promise<void>;
}

const SUMMARIZER_SYSTEM_MESSAGE =
  "You are a conversation summarizer. Your job is to create concise, " +
  "accurate summaries of conversations.";

const SUMMARIZER_DISPLAY_NAME = "Context Summarizer";

function formatTurnsForPrompt(turns: readonly ChatTurn[]): string {
  const lines: string[] = [];
  for (const t of turns) {
    const speaker = t.role === "user" ? "User" : (t.expertSlug ?? "Expert");
    lines.push(`${speaker}: ${t.content}`);
  }
  return lines.join("\n");
}

function buildSummarizationPrompt(
  existingSummary: string | null,
  turns: readonly ChatTurn[],
  summaryMaxWords: number,
): string {
  const summaryBlock = existingSummary ?? "No prior summary.";
  const turnsBlock = formatTurnsForPrompt(turns);
  return [
    "Here is the existing conversation summary:",
    summaryBlock,
    "",
    "Here are new turns to incorporate:",
    turnsBlock,
    "",
    "Write an updated summary of the full conversation so far.",
    `Keep it under ${summaryMaxWords} words.`,
    "Preserve key facts, decisions, and unresolved questions.",
    "Do not include the most recent turns (they are kept separately).",
  ].join("\n");
}

async function runSummarizer(
  engine: CouncilEngine,
  model: string,
  prompt: string,
): Promise<string | null> {
  const expertId = ulid();
  const spec: ExpertSpec = {
    id: expertId,
    slug: `__chat-summarizer-${expertId}`,
    displayName: SUMMARIZER_DISPLAY_NAME,
    model,
    systemMessage: SUMMARIZER_SYSTEM_MESSAGE,
  };

  try {
    await engine.addExpert(spec);
  } catch {
    return null;
  }

  let collected = "";
  let errored = false;
  try {
    const stream: AsyncIterable<EngineEvent> = engine.send({ prompt, expertId });
    for await (const event of stream) {
      if (event.kind === "message.delta") {
        collected += event.text;
      } else if (event.kind === "error") {
        errored = true;
        break;
      }
    }
  } catch {
    errored = true;
  } finally {
    await engine.removeExpert(expertId).catch(() => {
      /* best-effort cleanup */
    });
  }

  if (errored) return null;
  const trimmed = collected.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createContextManager(
  chatRepo: ChatRepository,
  engine: CouncilEngine,
  config: ContextManagerConfig,
): ContextManager {
  async function getContext(chatId: string): Promise<ChatContext> {
    const session = await chatRepo.findSessionById(chatId);
    if (!session) {
      throw new Error(`ContextManager.getContext: chat session ${chatId} not found`);
    }
    const recentTurns = await chatRepo.getTurns(chatId, {
      afterSeq: session.summaryThroughSeq,
    });
    return { summary: session.summary, recentTurns };
  }

  async function summarizeRange(
    chatId: string,
    fromSeqExclusive: number,
    throughSeq: number,
    existingSummary: string | null,
  ): Promise<boolean> {
    const limit = throughSeq - fromSeqExclusive;
    if (limit <= 0) return false;
    const turnsToSummarize = await chatRepo.getTurns(chatId, {
      afterSeq: fromSeqExclusive,
      limit,
    });
    if (turnsToSummarize.length === 0) return false;
    const prompt = buildSummarizationPrompt(
      existingSummary,
      turnsToSummarize,
      config.summaryMaxWords,
    );
    const newSummary = await runSummarizer(engine, config.model, prompt);
    if (newSummary === null) return false;
    const lastSeq = turnsToSummarize[turnsToSummarize.length - 1]?.seq ?? throughSeq;
    await chatRepo.updateSummary(chatId, newSummary, lastSeq);
    return true;
  }

  async function maybeSummarize(chatId: string): Promise<boolean> {
    const totalTurns = await chatRepo.getTurnCount(chatId);
    if (totalTurns <= config.recentTurnCount) return false;
    const session = await chatRepo.findSessionById(chatId);
    if (!session) return false;
    const throughSeq = totalTurns - config.recentTurnCount;
    return summarizeRange(chatId, session.summaryThroughSeq, throughSeq, session.summary);
  }

  async function forceSummarize(chatId: string): Promise<void> {
    const session = await chatRepo.findSessionById(chatId);
    if (!session) return;
    const totalTurns = await chatRepo.getTurnCount(chatId);
    if (totalTurns === 0) return;
    const throughSeq = Math.max(totalTurns - config.recentTurnCount, totalTurns);
    // forceSummarize covers EVERY existing turn; honor the "do not
    // include the most recent" framing only when maybeSummarize calls in.
    await summarizeRange(chatId, session.summaryThroughSeq, throughSeq, session.summary);
  }

  return { getContext, maybeSummarize, forceSummarize };
}
