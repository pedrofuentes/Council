import { toSingleLineDisplay } from "../../cli/strip-control-chars.js";
import type { ChatStatus, ChatTargetType } from "../../core/chat/chat-session.js";
import { formatRelativeTime } from "./home-data-sources.js";

/**
 * Minimal structural view of a persisted chat session row consumed by the
 * Chats screen. Accepts the real `ChatRepository.listSessions()` rows (which
 * carry extra fields) by structural typing.
 */
export interface ChatSessionSummary {
  readonly id: string;
  readonly targetType: ChatTargetType;
  readonly targetSlug: string;
  readonly summary: string | null;
  readonly status: ChatStatus;
  readonly updatedAt: string;
}

/** View-model for one row of the Chats list. */
export interface ChatListItem {
  readonly id: string;
  readonly targetType: ChatTargetType;
  /** Raw slug used to build the resume route — callers must `encodeURIComponent` it. */
  readonly targetSlug: string;
  /** Single-line, control-free display title (summary, or slug fallback). */
  readonly title: string;
  readonly when: string;
  readonly status: ChatStatus;
}

/** Repository the Chats data source reads from (structural — accepts `ChatRepository`). */
export interface ChatsRepo {
  readonly chat: { listSessions(): Promise<readonly ChatSessionSummary[]> };
}

export interface ChatsDataSource {
  readonly list: () => Promise<readonly ChatListItem[]>;
}

/** Glyph distinguishing a 1:1 expert chat from a panel chat in the list. */
export function chatTargetSymbol(targetType: ChatTargetType): string {
  return targetType === "panel" ? "📋" : "👤";
}

/**
 * Maps a persisted chat session to the Chats screen view-model. The title is
 * model/user-derived (a summary, or the slug) so it is sanitized to a single
 * control-free line; the `targetSlug` is kept raw for resume navigation.
 */
export function toChatListItem(session: ChatSessionSummary): ChatListItem {
  return {
    id: session.id,
    targetType: session.targetType,
    targetSlug: session.targetSlug,
    title: toSingleLineDisplay(session.summary ?? session.targetSlug),
    when: formatRelativeTime(session.updatedAt),
    status: session.status,
  };
}

/** Builds the Chats data source from the chat repository (used by the TUI entry point). */
export function createChatsDataSource(repos: ChatsRepo): ChatsDataSource {
  return {
    list: async (): Promise<readonly ChatListItem[]> => {
      const sessions = await repos.chat.listSessions();
      return sessions.map(toChatListItem);
    },
  };
}
