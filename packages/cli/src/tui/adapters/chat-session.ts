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
      const created = await deps.chat.createSession({ targetType, targetSlug });
      return { id: created.id };
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
