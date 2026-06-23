import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createChatSessionSource } from "../../../src/tui/adapters/chat-session.js";
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
