/**
 * Chat domain types — persistent multi-turn conversations between a user
 * and either a single expert or a whole panel (Roadmap 5.1).
 *
 * The shapes here are camelCase domain objects; the snake_case row types
 * live in `src/memory/db.ts` (ChatSessionRow / ChatTurnRow) and are mapped
 * by `ChatRepository`.
 */

export type ChatTargetType = "expert" | "panel";
export type ChatStatus = "active" | "archived";
export type ChatRole = "user" | "expert";

export interface ChatSession {
  readonly id: string;
  readonly targetType: ChatTargetType;
  readonly targetSlug: string;
  readonly status: ChatStatus;
  readonly summary: string | null;
  readonly summaryThroughSeq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChatTurn {
  readonly id: string;
  readonly chatId: string;
  readonly seq: number;
  readonly role: ChatRole;
  readonly expertSlug: string | null;
  readonly content: string;
  readonly isMention: boolean;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly createdAt: string;
}
