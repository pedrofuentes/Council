import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type ChatSessionDeps,
  createChatSessionSource,
} from "../../../src/tui/adapters/chat-session.js";
import type { ChatSession, ChatTargetType, ChatTurn } from "../../../src/core/chat/chat-session.js";
import { type CouncilDatabase, createDatabase } from "../../../src/memory/db.js";
import { ChatRepository } from "../../../src/memory/repositories/chat-repository.js";
import { copyTemplateDb } from "../../helpers/template-db.js";

const TEST_ROOT = path.join(process.cwd(), ".tmp-chat-session-tests");

interface TestContext {
  readonly db: CouncilDatabase;
  readonly repo: ChatRepository;
}

async function createContext(): Promise<TestContext> {
  await fs.mkdir(TEST_ROOT, { recursive: true });
  const dbPath = path.join(TEST_ROOT, `${randomUUID()}.db`);
  await copyTemplateDb(dbPath);
  const db = await createDatabase(dbPath);
  return { db, repo: new ChatRepository(db) };
}

describe("createChatSessionSource", () => {
  let db: CouncilDatabase;
  let repo: ChatRepository;

  beforeEach(async () => {
    const context = await createContext();
    db = context.db;
    repo = context.repo;
  });

  afterEach(async () => {
    await db.destroy();
    await fs.rm(TEST_ROOT, { force: true, recursive: true });
  });

  it("loads empty history when no active session exists", async () => {
    const source = createChatSessionSource({ chat: repo });

    await expect(source.loadHistory("panel", "launch")).resolves.toEqual({
      session: undefined,
      turns: [],
    });
  });

  it("loads sanitized history for an active session", async () => {
    const session = await repo.createSession({ targetType: "panel", targetSlug: "launch" });
    await repo.persistTurnPair(
      {
        chatId: session.id,
        role: "user",
        content: "hello\u0007\nworld",
        isMention: true,
      },
      {
        chatId: session.id,
        role: "expert",
        expertSlug: "cto\n\u001B[31mlead",
        content: "reply\u001B[31m\nnext",
      },
    );
    const source = createChatSessionSource({ chat: repo });

    await expect(source.loadHistory("panel", "launch")).resolves.toEqual({
      session: { id: session.id },
      turns: [
        expect.objectContaining({
          role: "user",
          expertSlug: null,
          content: "hello\nworld",
          isMention: true,
        }),
        expect.objectContaining({
          role: "expert",
          expertSlug: "cto lead",
          content: "reply\nnext",
          isMention: false,
        }),
      ],
    });
  });

  it("creates a session when absent and reuses the active session when present", async () => {
    const source = createChatSessionSource({ chat: repo });

    const created = await source.ensureSession("expert", "cto");
    const reused = await source.ensureSession("expert", "cto");

    expect(created.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(reused).toEqual(created);
  });

  it("routes general, mention, and convene input", () => {
    const source = createChatSessionSource({ chat: repo });

    expect(source.route("  ship it  ", ["cto", "cfo"])).toEqual({
      type: "general",
      targetSlugs: [],
      content: "ship it",
    });
    expect(source.route("@cto @cfo compare risks", ["cto", "cfo"])).toEqual({
      type: "mention",
      targetSlugs: ["cto", "cfo"],
      content: "compare risks",
    });
    expect(source.route("@convene roadmap tradeoffs", ["cto"])).toEqual({
      type: "convene",
      targetSlugs: [],
      content: "roadmap tradeoffs",
    });
    expect(() => source.route("@missing hi", ["cto"])).toThrow(
      'Expert "missing" is not in this panel. Available experts: cto',
    );
  });

  it("persists a user and expert turn pair", async () => {
    const session = await repo.createSession({ targetType: "panel", targetSlug: "launch" });
    const source = createChatSessionSource({ chat: repo });

    await source.persistTurn(session.id, {
      userContent: "What changed?",
      expertSlug: "cto",
      expertContent: "The adapter is offline.",
      isMention: true,
    });

    const turns = await repo.getTurns(session.id);
    expect(
      turns.map((turn) => ({
        role: turn.role,
        expertSlug: turn.expertSlug,
        content: turn.content,
        isMention: turn.isMention,
      })),
    ).toEqual([
      {
        role: "user",
        expertSlug: null,
        content: "What changed?",
        isMention: true,
      },
      {
        role: "expert",
        expertSlug: "cto",
        content: "The adapter is offline.",
        isMention: false,
      },
    ]);
  });
});

describe("createChatSessionSource ensureSession conflict recovery", () => {
  function makeSession(id: string, targetType: ChatTargetType, targetSlug: string): ChatSession {
    return {
      id,
      targetType,
      targetSlug,
      status: "active",
      summary: null,
      summaryThroughSeq: 0,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
  }

  it("recovers from a uniqueness conflict on create by re-querying the existing session", async () => {
    const existing = makeSession("EXISTINGSESSIONID0000000000", "expert", "cto");
    let findCalls = 0;
    let createCalls = 0;
    const chat: ChatSessionDeps["chat"] = {
      async findActiveSession(): Promise<ChatSession | undefined> {
        findCalls += 1;
        // First lookup observes no active session (as a racing caller would);
        // after a concurrent create wins, the session is present.
        return findCalls === 1 ? undefined : existing;
      },
      async createSession(): Promise<ChatSession> {
        createCalls += 1;
        // The concurrent winner already landed the active session, so this
        // insert trips the partial unique index idx_chat_sessions_active_unique.
        // Message shape mirrors node:sqlite exactly (verified against the real
        // driver): the columns are named even for the partial index.
        throw new Error(
          "UNIQUE constraint failed: chat_sessions.target_type, chat_sessions.target_slug",
        );
      },
      async getTurns(): Promise<readonly ChatTurn[]> {
        return [];
      },
      async persistTurnPair(): Promise<readonly [ChatTurn, ChatTurn]> {
        throw new Error("persistTurnPair is not exercised by this test");
      },
    };
    const source = createChatSessionSource({ chat });

    const result = await source.ensureSession("expert", "cto");

    // The create conflict must not surface: ensureSession re-queries and
    // returns the session the concurrent caller created.
    expect(result).toEqual({ id: "EXISTINGSESSIONID0000000000" });
    expect(createCalls).toBe(1);
    expect(findCalls).toBe(2);
  });

  it("re-throws a non-uniqueness constraint error instead of recovering", async () => {
    const existing = makeSession("SHOULDNOTBEUSED000000000000", "expert", "cto");
    let findCalls = 0;
    let createCalls = 0;
    const chat: ChatSessionDeps["chat"] = {
      async findActiveSession(): Promise<ChatSession | undefined> {
        findCalls += 1;
        // If recovery were (wrongly) attempted, this re-query would hand back a
        // session and mask the real failure — so return one to expose the bug.
        return findCalls === 1 ? undefined : existing;
      },
      async createSession(): Promise<ChatSession> {
        createCalls += 1;
        // A CHECK violation is a constraint error but NOT the active-session
        // uniqueness race. It must be re-thrown, not swallowed and hidden behind
        // an unrelated existing session.
        throw new Error("CHECK constraint failed: chat_sessions.status");
      },
      async getTurns(): Promise<readonly ChatTurn[]> {
        return [];
      },
      async persistTurnPair(): Promise<readonly [ChatTurn, ChatTurn]> {
        throw new Error("persistTurnPair is not exercised by this test");
      },
    };
    const source = createChatSessionSource({ chat });

    await expect(source.ensureSession("expert", "cto")).rejects.toThrow("CHECK constraint failed");
    expect(createCalls).toBe(1);
    // The non-uniqueness error must short-circuit BEFORE any recovery re-query.
    expect(findCalls).toBe(1);
  });

  it("re-throws non-constraint errors from create without re-querying", async () => {
    let findCalls = 0;
    let createCalls = 0;
    const chat: ChatSessionDeps["chat"] = {
      async findActiveSession(): Promise<ChatSession | undefined> {
        findCalls += 1;
        return undefined;
      },
      async createSession(): Promise<ChatSession> {
        createCalls += 1;
        throw new Error("disk is full");
      },
      async getTurns(): Promise<readonly ChatTurn[]> {
        return [];
      },
      async persistTurnPair(): Promise<readonly [ChatTurn, ChatTurn]> {
        throw new Error("persistTurnPair is not exercised by this test");
      },
    };
    const source = createChatSessionSource({ chat });

    // A genuine, non-uniqueness failure must not be swallowed by the recovery
    // path, and must not trigger a second lookup.
    await expect(source.ensureSession("expert", "cto")).rejects.toThrow("disk is full");
    expect(createCalls).toBe(1);
    expect(findCalls).toBe(1);
  });
});
