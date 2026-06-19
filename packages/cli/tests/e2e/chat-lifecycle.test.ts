import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildChatCommand, type ChatInputProvider } from "../../src/cli/commands/chat.js";
import { FileExpertLibrary } from "../../src/core/expert-library.js";
import type { ExpertDefinition } from "../../src/core/expert.js";
import type { CouncilEngine } from "../../src/engine/index.js";
import type { ChatSessionRow, ChatTurnRow } from "../../src/memory/db.js";
import {
  captureOutput,
  cleanupE2EContext,
  createE2EContext,
  destroyTestDb,
  makeMockEngineFactory,
  openTestDb,
  type E2EContext,
} from "./helpers.js";

interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

interface RunChatOptions {
  readonly lines?: readonly string[];
  readonly engineFactory?: () => CouncilEngine;
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function createScriptedInput(lines: readonly string[]): ChatInputProvider {
  let index = 0;
  return {
    async readLine(): Promise<string | null> {
      const nextLine = lines[index];
      index += 1;
      return nextLine ?? null;
    },
    close(): void {
      /* no-op */
    },
  };
}

async function runChatCommand(
  args: readonly string[],
  options: RunChatOptions = {},
): Promise<CommandOutput> {
  const output = captureOutput();
  const engineFactory =
    options.engineFactory ?? (options.lines !== undefined ? makeMockEngineFactory() : undefined);
  const command = buildChatCommand({
    write: output.write,
    writeError: output.writeError,
    ...(engineFactory === undefined ? {} : { engineFactory }),
    ...(options.lines === undefined
      ? {}
      : { inputProvider: (): ChatInputProvider => createScriptedInput(options.lines) }),
  });

  await command.parseAsync(["node", "council-chat", ...args]);
  return {
    stdout: output.stdout(),
    stderr: output.stderr(),
  };
}

function buildExpertDefinition(slug: string, displayName: string, role: string): ExpertDefinition {
  return {
    slug,
    displayName,
    role,
    expertise: {
      weightedEvidence: [`${slug} evidence`],
      referenceCases: [],
      notExpertIn: [],
    },
    epistemicStance: `${slug} stance`,
    kind: "generic",
  };
}

async function seedExpert(ctx: E2EContext, definition: ExpertDefinition): Promise<void> {
  const db = await openTestDb(ctx.testHome);
  try {
    const library = new FileExpertLibrary(ctx.testDataHome, db);
    await library.create(definition);
  } finally {
    await destroyTestDb(db);
  }
}

async function seedPanel(
  ctx: E2EContext,
  name: string,
  expertSlugs: readonly string[],
): Promise<void> {
  const panelYaml = [
    `name: ${name}`,
    `description: ${name} panel`,
    "experts:",
    ...expertSlugs.map((slug) => `  - ${slug}`),
    "",
  ].join("\n");
  await fs.writeFile(path.join(ctx.testDataHome, "panels", `${name}.yaml`), panelYaml, "utf-8");
}

async function listChatSessions(
  ctx: E2EContext,
  filters: {
    readonly targetType?: "expert" | "panel";
    readonly targetSlug?: string;
    readonly status?: "active" | "archived";
  } = {},
): Promise<readonly ChatSessionRow[]> {
  const db = await openTestDb(ctx.testHome);
  try {
    let query = db.selectFrom("chat_sessions").selectAll();
    if (filters.targetType !== undefined) {
      query = query.where("target_type", "=", filters.targetType);
    }
    if (filters.targetSlug !== undefined) {
      query = query.where("target_slug", "=", filters.targetSlug);
    }
    if (filters.status !== undefined) {
      query = query.where("status", "=", filters.status);
    }
    return await query.orderBy("created_at", "asc").orderBy("id", "asc").execute();
  } finally {
    await destroyTestDb(db);
  }
}

async function readChatTurns(ctx: E2EContext, chatId: string): Promise<readonly ChatTurnRow[]> {
  const db = await openTestDb(ctx.testHome);
  try {
    return await db
      .selectFrom("chat_turns")
      .selectAll()
      .where("chat_id", "=", chatId)
      .orderBy("seq", "asc")
      .execute();
  } finally {
    await destroyTestDb(db);
  }
}

async function archiveChatSession(ctx: E2EContext, chatId: string): Promise<void> {
  const db = await openTestDb(ctx.testHome);
  try {
    await db
      .updateTable("chat_sessions")
      .set({ status: "archived", updated_at: new Date().toISOString() })
      .where("id", "=", chatId)
      .execute();
  } finally {
    await destroyTestDb(db);
  }
}

describe("chat lifecycle e2e", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await createE2EContext();
  });

  afterEach(async () => {
    await cleanupE2EContext(ctx);
  }, 60_000);

  it("1:1 chat: single turn persists the session and turns", async () => {
    await seedExpert(ctx, buildExpertDefinition("cto", "CTO", "Technology lead"));

    const output = await runChatCommand(["cto", "--engine", "mock"], {
      lines: ["Hello", "exit"],
    });

    expect(output.stdout).toMatch(/Starting 1:1 chat/i);
    expect(output.stdout).toMatch(/Conversation saved/i);

    const sessions = await listChatSessions(ctx, { targetType: "expert", targetSlug: "cto" });
    expect(sessions).toHaveLength(1);
    const session = requireValue(sessions[0], "Expected a persisted chat session.");
    expect(session.status).toBe("active");

    const turns = await readChatTurns(ctx, session.id);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.role).toBe("user");
    expect(turns[0]?.content).toBe("Hello");
    expect(turns[1]?.role).toBe("expert");
    expect(turns[1]?.expert_slug).toBe("cto");
  });

  it("1:1 chat: multi-turn conversation persists three user and three assistant turns", async () => {
    await seedExpert(ctx, buildExpertDefinition("cto", "CTO", "Technology lead"));

    await runChatCommand(["cto", "--engine", "mock"], {
      lines: ["First", "Second", "Third", "exit"],
    });

    const sessions = await listChatSessions(ctx, { targetType: "expert", targetSlug: "cto" });
    const session = requireValue(sessions[0], "Expected a persisted chat session.");
    const turns = await readChatTurns(ctx, session.id);

    expect(turns.filter((turn) => turn.role === "user")).toHaveLength(3);
    expect(turns.filter((turn) => turn.role === "expert")).toHaveLength(3);
    expect(turns.map((turn) => turn.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("1:1 chat: --list shows persisted sessions", async () => {
    await seedExpert(ctx, buildExpertDefinition("cto", "CTO", "Technology lead"));
    await runChatCommand(["cto", "--engine", "mock"], {
      lines: ["Hello", "exit"],
    });

    const output = await runChatCommand(["--list"]);

    expect(output.stdout).toContain("cto");
    expect(output.stdout).toMatch(/\bactive\b/i);
    expect(output.stdout).toContain("2");
  });

  it("1:1 chat: --history shows archived sessions", async () => {
    await seedExpert(ctx, buildExpertDefinition("cto", "CTO", "Technology lead"));
    await runChatCommand(["cto", "--engine", "mock"], {
      lines: ["Hello", "exit"],
    });

    const [activeSessionRow] = await listChatSessions(ctx, {
      targetType: "expert",
      targetSlug: "cto",
      status: "active",
    });
    const activeSession = requireValue(activeSessionRow, "Expected an active chat session.");
    await archiveChatSession(ctx, activeSession.id);

    const archivedTurns = await readChatTurns(ctx, activeSession.id);
    const output = await runChatCommand(["cto", "--history"]);

    expect(archivedTurns).toHaveLength(2);
    expect(output.stdout).toContain(activeSession.id);
    expect(output.stdout).toMatch(/\barchived\b/i);
    expect(output.stdout).toContain(String(archivedTurns.length));
  });

  it("1:1 chat: session resume keeps using the active session", async () => {
    await seedExpert(ctx, buildExpertDefinition("cto", "CTO", "Technology lead"));

    await runChatCommand(["cto", "--engine", "mock"], {
      lines: ["First hello", "exit"],
    });
    const [firstSession] = await listChatSessions(ctx, {
      targetType: "expert",
      targetSlug: "cto",
      status: "active",
    });

    const output = await runChatCommand(["cto", "--engine", "mock"], {
      lines: ["Back again", "exit"],
    });
    const [resumedSessionRow] = await listChatSessions(ctx, {
      targetType: "expert",
      targetSlug: "cto",
      status: "active",
    });
    const resumedSession = requireValue(resumedSessionRow, "Expected a resumed chat session.");
    const turns = await readChatTurns(ctx, resumedSession.id);

    expect(output.stdout).toMatch(/Resuming conversation/i);
    expect(resumedSession?.id).toBe(firstSession?.id);
    expect(turns.filter((turn) => turn.role === "user")).toHaveLength(2);
    expect(turns.filter((turn) => turn.role === "expert")).toHaveLength(2);
  });

  it("panel chat: @mention routes only to the addressed expert", async () => {
    await seedExpert(ctx, buildExpertDefinition("cto", "CTO", "Technology lead"));
    await seedExpert(ctx, buildExpertDefinition("pm", "PM", "Product lead"));
    await seedPanel(ctx, "leadership", ["cto", "pm"]);

    await runChatCommand(["leadership", "--engine", "mock"], {
      lines: ["@cto What changed?", "exit"],
    });

    const [sessionRow] = await listChatSessions(ctx, {
      targetType: "panel",
      targetSlug: "leadership",
      status: "active",
    });
    const session = requireValue(sessionRow, "Expected an active panel chat session.");
    const turns = await readChatTurns(ctx, session.id);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.role).toBe("user");
    expect(turns[0]?.content).toBe("What changed?");
    expect(turns[0]?.is_mention).toBe(1);
    expect(turns[1]?.role).toBe("expert");
    expect(turns[1]?.expert_slug).toBe("cto");
    expect(turns[1]?.is_mention).toBe(1);
  });

  it("panel chat: general messages fan out to both experts", async () => {
    await seedExpert(ctx, buildExpertDefinition("cto", "CTO", "Technology lead"));
    await seedExpert(ctx, buildExpertDefinition("pm", "PM", "Product lead"));
    await seedPanel(ctx, "leadership", ["cto", "pm"]);

    await runChatCommand(["leadership", "--engine", "mock"], {
      lines: ["What should we do?", "exit"],
    });

    const [sessionRow] = await listChatSessions(ctx, {
      targetType: "panel",
      targetSlug: "leadership",
      status: "active",
    });
    const session = requireValue(sessionRow, "Expected an active panel chat session.");
    const turns = await readChatTurns(ctx, session.id);
    const expertSlugs = turns
      .filter((turn) => turn.role === "expert")
      .map((turn) => turn.expert_slug)
      .sort();

    expect(turns).toHaveLength(3);
    expect(turns[0]?.is_mention).toBe(0);
    expect(expertSlugs).toEqual(["cto", "pm"]);
    expect(turns.filter((turn) => turn.role === "expert" && turn.is_mention === 0)).toHaveLength(2);
  });

  it("chat with --new archives the existing session and starts a new one", async () => {
    await seedExpert(ctx, buildExpertDefinition("cto", "CTO", "Technology lead"));

    await runChatCommand(["cto", "--engine", "mock"], {
      lines: ["Original thread", "exit"],
    });
    const [firstSession] = await listChatSessions(ctx, {
      targetType: "expert",
      targetSlug: "cto",
      status: "active",
    });

    const output = await runChatCommand(["cto", "--engine", "mock", "--new"], {
      lines: ["Fresh thread", "exit"],
    });
    const allSessions = await listChatSessions(ctx, {
      targetType: "expert",
      targetSlug: "cto",
    });
    const archivedSession = allSessions.find((session) => session.status === "archived");
    const activeSession = allSessions.find((session) => session.status === "active");

    expect(output.stdout).toMatch(/archived/i);
    expect(allSessions).toHaveLength(2);
    expect(archivedSession?.id).toBe(firstSession?.id);
    expect(activeSession?.id).not.toBe(firstSession?.id);
    const archived = requireValue(archivedSession, "Expected an archived session.");
    const active = requireValue(activeSession, "Expected a new active session.");

    expect(await readChatTurns(ctx, archived.id)).toHaveLength(2);
    expect(await readChatTurns(ctx, active.id)).toHaveLength(2);
  });
});
