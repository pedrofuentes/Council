import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildChatCommand, type ChatInputProvider } from "../../src/cli/commands/chat.js";
import { FileExpertLibrary } from "../../src/core/expert-library.js";
import type { ExpertDefinition } from "../../src/core/expert.js";
import type { CouncilEngine } from "../../src/engine/index.js";
import type { ChatSessionRow, ChatTurnRow } from "../../src/memory/db.js";
import { captureOutput, makeMockEngineFactory, openTestDb } from "./helpers.js";

interface LocalE2EContext {
  readonly rootDir: string;
  readonly testHome: string;
  readonly testDataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

interface RunChatOptions {
  readonly lines?: readonly string[];
  readonly engineFactory?: () => CouncilEngine;
}

function restoreEnvVar(
  name: "COUNCIL_HOME" | "COUNCIL_DATA_HOME",
  value: string | undefined,
): void {
  if (name === "COUNCIL_HOME") {
    if (value === undefined) delete process.env.COUNCIL_HOME;
    else process.env.COUNCIL_HOME = value;
    return;
  }

  if (value === undefined) delete process.env.COUNCIL_DATA_HOME;
  else process.env.COUNCIL_DATA_HOME = value;
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

async function removeDirWithRetry(dirPath: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rm(dirPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { readonly code?: unknown }).code)
          : undefined;
      if (code !== "EBUSY" || attempt === 5) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
}

async function createLocalE2EContext(): Promise<LocalE2EContext> {
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  const rootDir = await fs.mkdtemp(path.join(process.cwd(), ".chat-lifecycle-e2e-"));
  const testHome = path.join(rootDir, "home");
  const testDataHome = path.join(rootDir, "data");

  await fs.mkdir(path.join(testDataHome, "experts"), { recursive: true });
  await fs.mkdir(path.join(testDataHome, "panels"), { recursive: true });
  await fs.mkdir(testHome, { recursive: true });

  process.env["COUNCIL_HOME"] = testHome;
  process.env["COUNCIL_DATA_HOME"] = testDataHome;

  return {
    rootDir,
    testHome,
    testDataHome,
    originalHome,
    originalDataHome,
  };
}

async function cleanupLocalE2EContext(ctx: LocalE2EContext): Promise<void> {
  restoreEnvVar("COUNCIL_HOME", ctx.originalHome);
  restoreEnvVar("COUNCIL_DATA_HOME", ctx.originalDataHome);
  await removeDirWithRetry(ctx.rootDir);
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

async function seedExpert(ctx: LocalE2EContext, definition: ExpertDefinition): Promise<void> {
  const db = await openTestDb(ctx.testHome);
  try {
    const library = new FileExpertLibrary(ctx.testDataHome, db);
    await library.create(definition);
  } finally {
    await db.destroy();
  }
}

async function seedPanel(
  ctx: LocalE2EContext,
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
  ctx: LocalE2EContext,
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
    await db.destroy();
  }
}

async function readChatTurns(
  ctx: LocalE2EContext,
  chatId: string,
): Promise<readonly ChatTurnRow[]> {
  const db = await openTestDb(ctx.testHome);
  try {
    return await db
      .selectFrom("chat_turns")
      .selectAll()
      .where("chat_id", "=", chatId)
      .orderBy("seq", "asc")
      .execute();
  } finally {
    await db.destroy();
  }
}

async function archiveChatSession(ctx: LocalE2EContext, chatId: string): Promise<void> {
  const db = await openTestDb(ctx.testHome);
  try {
    await db
      .updateTable("chat_sessions")
      .set({ status: "archived", updated_at: new Date().toISOString() })
      .where("id", "=", chatId)
      .execute();
  } finally {
    await db.destroy();
  }
}

describe("chat lifecycle e2e", () => {
  let ctx: LocalE2EContext;
  const createdContexts: LocalE2EContext[] = [];

  beforeEach(async () => {
    ctx = await createLocalE2EContext();
    createdContexts.push(ctx);
  });

  afterEach(() => {
    restoreEnvVar("COUNCIL_HOME", ctx.originalHome);
    restoreEnvVar("COUNCIL_DATA_HOME", ctx.originalDataHome);
  });

  afterAll(async () => {
    for (const createdContext of createdContexts.reverse()) {
      await cleanupLocalE2EContext(createdContext);
    }
  }, 60000);

  it("1:1 chat: single turn persists the session and turns", async () => {
    await seedExpert(ctx, buildExpertDefinition("cto", "CTO", "Technology lead"));

    const output = await runChatCommand(["cto", "--engine", "mock"], {
      lines: ["Hello", "exit"],
    });

    expect(output.stdout).toMatch(/Starting new conversation/i);
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
