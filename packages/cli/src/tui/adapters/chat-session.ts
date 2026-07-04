import type { ChatTargetType, ChatTurn } from "../../core/chat/chat-session.js";
import { parseUserInput } from "../../core/chat/mention-parser.js";
import { stripControlChars, toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { ChatRepository, NewChatTurn } from "../../memory/repositories/chat-repository.js";

export interface ChatTurnView {
  readonly id: string;
  readonly role: "user" | "expert";
  readonly expertSlug: string | null;
  readonly content: string;
  readonly isMention: boolean;
}

export interface ChatHistory {
  readonly session: { readonly id: string } | undefined;
  readonly turns: readonly ChatTurnView[];
}

export interface ChatRouteResult {
  readonly type: "general" | "mention" | "convene";
  readonly targetSlugs: readonly string[];
  readonly content: string;
}

export interface ChatSessionDataSource {
  loadHistory(targetType: "expert" | "panel", targetSlug: string): Promise<ChatHistory>;
  ensureSession(
    targetType: "expert" | "panel",
    targetSlug: string,
  ): Promise<{ readonly id: string }>;
  route(input: string, availableSlugs: readonly string[]): ChatRouteResult;
  persistTurn(
    sessionId: string,
    turn: {
      readonly userContent: string;
      readonly expertSlug: string;
      readonly expertContent: string;
      readonly isMention: boolean;
    },
  ): Promise<void>;
}

export interface ChatSessionDeps {
  readonly chat: Pick<
    ChatRepository,
    "findActiveSession" | "createSession" | "getTurns" | "persistTurnPair"
  >;
}

function toTurnView(turn: ChatTurn): ChatTurnView {
  return {
    id: turn.id,
    role: turn.role,
    expertSlug: turn.expertSlug === null ? null : toSingleLineDisplay(turn.expertSlug),
    content: stripControlChars(turn.content),
    isMention: turn.isMention,
  };
}

/**
 * True only for the specific active-session uniqueness conflict: a concurrent
 * create that trips the partial unique index `idx_chat_sessions_active_unique`
 * (chat_sessions(target_type, target_slug) WHERE status = 'active'). node:sqlite
 * surfaces that as `UNIQUE constraint failed: chat_sessions.target_type,
 * chat_sessions.target_slug` (verified against the real driver; the columns are
 * named even for the partial index).
 *
 * Deliberately narrower than the `rewriteRotateError` check in
 * cli/commands/chat/shared.ts: matching a generic "constraint" (or even the
 * UNIQUE class alone) would also swallow a future CHECK / FOREIGN KEY / NOT NULL
 * constraint on chat_sessions (they use a different phrase) or a PRIMARY-KEY /
 * other-column UNIQUE (different columns), masking a genuine bug. We therefore
 * require BOTH the UNIQUE-failure phrase AND the two active-session index
 * columns. The cause is folded in so a wrapped error is still recognised.
 */
function isActiveSessionUniquenessConflict(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const text = `${err.message} ${err.cause !== undefined ? String(err.cause) : ""}`.toLowerCase();
  return (
    text.includes("unique constraint failed") &&
    text.includes("chat_sessions.target_type") &&
    text.includes("chat_sessions.target_slug")
  );
}

export function createChatSessionSource(deps: ChatSessionDeps): ChatSessionDataSource {
  return {
    async loadHistory(targetType: ChatTargetType, targetSlug: string): Promise<ChatHistory> {
      const session = await deps.chat.findActiveSession(targetType, targetSlug);
      if (session === undefined) {
        return { session: undefined, turns: [] };
      }
      const turns = await deps.chat.getTurns(session.id);
      return {
        session: { id: session.id },
        turns: turns.map(toTurnView),
      };
    },

    async ensureSession(
      targetType: ChatTargetType,
      targetSlug: string,
    ): Promise<{ readonly id: string }> {
      const session = await deps.chat.findActiveSession(targetType, targetSlug);
      if (session !== undefined) {
        return { id: session.id };
      }
      try {
        const created = await deps.chat.createSession({ targetType, targetSlug });
        return { id: created.id };
      } catch (err) {
        // Check-then-create races: a concurrent caller can land the active
        // session between our findActiveSession and createSession, tripping the
        // partial unique index (idx_chat_sessions_active_unique). Recover by
        // re-querying the now-present session instead of surfacing the conflict.
        // Only THIS specific uniqueness conflict is swallowed (not any other
        // constraint), and only when the re-query actually finds the winner's
        // session — otherwise re-throw.
        if (!isActiveSessionUniquenessConflict(err)) {
          throw err;
        }
        const existing = await deps.chat.findActiveSession(targetType, targetSlug);
        if (existing === undefined) {
          throw err;
        }
        return { id: existing.id };
      }
    },

    route(input: string, availableSlugs: readonly string[]): ChatRouteResult {
      const parsed = parseUserInput(input, availableSlugs);
      return {
        type: parsed.type,
        targetSlugs: parsed.targetSlugs,
        content: parsed.content,
      };
    },

    async persistTurn(
      sessionId: string,
      turn: {
        readonly userContent: string;
        readonly expertSlug: string;
        readonly expertContent: string;
        readonly isMention: boolean;
      },
    ): Promise<void> {
      const userInput: NewChatTurn = {
        chatId: sessionId,
        role: "user",
        content: turn.userContent,
        isMention: turn.isMention,
      };
      const expertInput: NewChatTurn = {
        chatId: sessionId,
        role: "expert",
        expertSlug: turn.expertSlug,
        content: turn.expertContent,
      };
      await deps.chat.persistTurnPair(userInput, expertInput);
    },
  };
}
