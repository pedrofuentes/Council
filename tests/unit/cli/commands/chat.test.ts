/**
 * Tests for `council chat` CLI command (Roadmap 5.2 — 1:1 expert chat).
 *
 * Non-interactive paths and the pure prompt-construction helper are
 * exercised here. The interactive `readline` loop is verified via an
 * injected `ChatInputProvider`; raw terminal input is NOT covered (manual
 * testing only, per task spec).
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildChatCommand,
  buildChatTurnPrompt,
  type ChatInputProvider,
} from "../../../../src/cli/commands/chat.js";
import { FileExpertLibrary } from "../../../../src/core/expert-library.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import type { ChatTurn } from "../../../../src/core/chat/chat-session.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { ChatRepository } from "../../../../src/memory/repositories/chat-repository.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-chat-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-chat-data-"));
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  process.env["COUNCIL_HOME"] = home;
  process.env["COUNCIL_DATA_HOME"] = dataHome;
  return { home, dataHome, originalHome, originalDataHome };
}

async function teardown(env: TestEnv): Promise<void> {
  if (env.originalHome === undefined) delete process.env["COUNCIL_HOME"];
  else process.env["COUNCIL_HOME"] = env.originalHome;
  if (env.originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
  else process.env["COUNCIL_DATA_HOME"] = env.originalDataHome;
  for (const dir of [env.home, env.dataHome]) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* ignore */
    }
  }
}

const SAMPLE: ExpertDefinition = {
  slug: "dahlia-cto",
  displayName: "Dahlia Renner (CTO)",
  role: "Skeptical CTO with 20 years of experience",
  expertise: {
    weightedEvidence: ["production incident data"],
    referenceCases: [],
    notExpertIn: [],
  },
  epistemicStance: "Bayesian skeptic",
  kind: "generic",
};

async function seedExpert(env: TestEnv, def: ExpertDefinition = SAMPLE): Promise<void> {
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const lib = new FileExpertLibrary(env.dataHome, db);
    await lib.create(def);
  } finally {
    await db.destroy();
  }
}

async function withRepo<T>(env: TestEnv, fn: (repo: ChatRepository) => Promise<T>): Promise<T> {
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    return await fn(new ChatRepository(db));
  } finally {
    await db.destroy();
  }
}

function scriptedInput(lines: readonly string[]): ChatInputProvider {
  let i = 0;
  return {
    async readLine(): Promise<string | null> {
      if (i >= lines.length) return null;
      const line = lines[i] ?? null;
      i += 1;
      return line;
    },
    close(): void {
      /* no-op */
    },
  };
}

describe("buildChatCommand", () => {
  it("registers a 'chat' command", () => {
    const cmd = buildChatCommand();
    expect(cmd.name()).toBe("chat");
  });

  describe("buildChatTurnPrompt (pure)", () => {
    it("returns just the user message when there is no history", () => {
      const out = buildChatTurnPrompt({
        history: [],
        userMessage: "What's our biggest risk?",
        expertDisplayName: "Dahlia Renner (CTO)",
      });
      expect(out).toBe("What's our biggest risk?");
    });

    it("formats prior turns with role labels and appends the new user message", () => {
      const history: readonly ChatTurn[] = [
        {
          id: "t1",
          chatId: "c1",
          seq: 1,
          role: "user",
          expertSlug: null,
          content: "Hi",
          isMention: false,
          tokensIn: null,
          tokensOut: null,
          createdAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "t2",
          chatId: "c1",
          seq: 2,
          role: "expert",
          expertSlug: "dahlia-cto",
          content: "Hello there.",
          isMention: false,
          tokensIn: null,
          tokensOut: null,
          createdAt: "2024-01-01T00:00:01Z",
        },
      ];
      const out = buildChatTurnPrompt({
        history,
        userMessage: "Tell me more",
        expertDisplayName: "Dahlia Renner (CTO)",
      });
      expect(out).toContain("PRIOR CONVERSATION");
      expect(out).toContain("User: Hi");
      expect(out).toContain("Dahlia Renner (CTO): Hello there.");
      expect(out).toContain("Tell me more");
      // The new user message must come after the history block.
      expect(out.indexOf("Hello there.")).toBeLessThan(out.indexOf("Tell me more"));
    });
  });

  describe("--list", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("prints empty-state hint when no chat sessions exist", async () => {
      let out = "";
      const cmd = buildChatCommand({ write: (s) => (out += s) });
      await cmd.parseAsync(["node", "council-chat", "--list"]);
      expect(out.toLowerCase()).toMatch(/no (chat )?conversations/);
    });

    it("lists active and archived sessions in a table", async () => {
      await seedExpert(env);
      await withRepo(env, async (repo) => {
        const a = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        await repo.addTurn({ chatId: a.id, role: "user", content: "hi" });
        const b = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        await repo.archiveSession(b.id);
      });
      let out = "";
      const cmd = buildChatCommand({ write: (s) => (out += s) });
      await cmd.parseAsync(["node", "council-chat", "--list"]);
      expect(out).toContain("dahlia-cto");
      expect(out).toContain("active");
      expect(out).toContain("archived");
    });
  });

  describe("--history", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("requires a target", async () => {
      const cmd = buildChatCommand({
        write: () => undefined,
        writeError: () => undefined,
      });
      await expect(
        cmd.parseAsync(["node", "council-chat", "--history"]),
      ).rejects.toThrow(/target|expert/i);
    });

    it("lists archived sessions only for the target", async () => {
      await seedExpert(env);
      await withRepo(env, async (repo) => {
        const a = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        await repo.archiveSession(a.id);
        const b = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        await repo.addTurn({ chatId: b.id, role: "user", content: "active" });
        // active session should not appear under --history
      });
      let out = "";
      const cmd = buildChatCommand({ write: (s) => (out += s) });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--history"]);
      // Both sessions belong to dahlia-cto; only the archived one shown.
      const archivedCount = (out.match(/archived/g) ?? []).length;
      expect(archivedCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("expert resolution", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("errors when --engine is missing", async () => {
      await seedExpert(env);
      let err = "";
      const cmd = buildChatCommand({
        write: () => undefined,
        writeError: (s) => (err += s),
      });
      await expect(
        cmd.parseAsync(["node", "council-chat", "dahlia-cto"]),
      ).rejects.toThrow(/--engine is required/i);
    });

    it("errors when --engine value is unknown", async () => {
      await seedExpert(env);
      const cmd = buildChatCommand({
        write: () => undefined,
        writeError: () => undefined,
      });
      await expect(
        cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "bogus"]),
      ).rejects.toThrow(/--engine is required.*mock|copilot/i);
    });

    it("errors when the expert slug does not exist", async () => {
      let err = "";
      const cmd = buildChatCommand({
        write: () => undefined,
        writeError: (s) => (err += s),
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput([]),
      });
      await expect(
        cmd.parseAsync(["node", "council-chat", "ghost", "--engine", "mock"]),
      ).rejects.toThrow(/not found/i);
      expect(err).toMatch(/not found/i);
      expect(err).toMatch(/dahlia-cto|Available experts/i);
    });
  });

  describe("session lifecycle", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("creates a new session, persists user + expert turns, and exits on /quit", async () => {
      await seedExpert(env);
      let out = "";
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput(["hello there", "/quit"]),
      });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);

      expect(out).toMatch(/Starting new conversation/i);
      expect(out).toMatch(/Conversation saved/i);

      await withRepo(env, async (repo) => {
        const session = await repo.findActiveSession("expert", "dahlia-cto");
        expect(session).toBeDefined();
        const turns = await repo.getTurns(session?.id ?? "");
        expect(turns.length).toBe(2);
        expect(turns[0]?.role).toBe("user");
        expect(turns[0]?.content).toBe("hello there");
        expect(turns[1]?.role).toBe("expert");
        expect(turns[1]?.expertSlug).toBe("dahlia-cto");
        expect(turns[1]?.content.length).toBeGreaterThan(0);
      });
    });

    it("resumes an active session and shows resume banner", async () => {
      await seedExpert(env);
      await withRepo(env, async (repo) => {
        const s = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        await repo.addTurn({ chatId: s.id, role: "user", content: "earlier" });
        await repo.addTurn({
          chatId: s.id,
          role: "expert",
          expertSlug: "dahlia-cto",
          content: "earlier reply",
        });
      });

      let out = "";
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput(["exit"]),
      });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);
      expect(out).toMatch(/Resuming conversation/i);
      expect(out).toMatch(/2 messages/i);
    });

    it("--new archives the existing active session and starts fresh", async () => {
      await seedExpert(env);
      let priorId = "";
      await withRepo(env, async (repo) => {
        const s = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        priorId = s.id;
        await repo.addTurn({ chatId: s.id, role: "user", content: "old" });
      });

      let out = "";
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput(["exit"]),
      });
      await cmd.parseAsync([
        "node",
        "council-chat",
        "dahlia-cto",
        "--engine",
        "mock",
        "--new",
      ]);

      expect(out).toMatch(/archived/i);

      await withRepo(env, async (repo) => {
        const prior = await repo.findSessionById(priorId);
        expect(prior?.status).toBe("archived");
        const active = await repo.findActiveSession("expert", "dahlia-cto");
        expect(active).toBeDefined();
        expect(active?.id).not.toBe(priorId);
      });
    });

    it("--new does NOT archive the prior session when engine startup fails", async () => {
      await seedExpert(env);
      let priorId = "";
      await withRepo(env, async (repo) => {
        const s = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        priorId = s.id;
        await repo.addTurn({ chatId: s.id, role: "user", content: "old" });
      });

      // Engine that fails on addExpert immediately.
      const failing = new MockEngine({ failOnAddExpert: { afterN: 0 } });
      const cmd = buildChatCommand({
        write: () => undefined,
        writeError: () => undefined,
        engineFactory: () => failing,
        inputProvider: () => scriptedInput([]),
      });
      await expect(
        cmd.parseAsync([
          "node",
          "council-chat",
          "dahlia-cto",
          "--engine",
          "mock",
          "--new",
        ]),
      ).rejects.toThrow();

      await withRepo(env, async (repo) => {
        const prior = await repo.findSessionById(priorId);
        // Atomicity: prior session must remain ACTIVE since startup failed.
        expect(prior?.status).toBe("active");
      });
    });

    it("exits gracefully on EOF (input provider returns null)", async () => {
      await seedExpert(env);
      let out = "";
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput([]),
      });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);
      expect(out).toMatch(/Conversation saved/i);
    });

    it("on engine error: saves the user turn, warns, and continues the loop", async () => {
      await seedExpert(env);

      // Custom engine: succeeds add/start/stop but every send() yields
      // a non-recoverable error event. Lets us assert the failure path
      // without depending on MockEngine's expertId-keyed failure seams
      // (chat.ts assigns a fresh ULID per spec).
      const failingEngine: CouncilEngine = {
        async start(): Promise<void> {
          /* ok */
        },
        async stop(): Promise<void> {
          /* ok */
        },
        async addExpert(): Promise<void> {
          /* ok */
        },
        async removeExpert(): Promise<void> {
          /* ok */
        },
        async listModels(): Promise<readonly string[]> {
          return ["mock"];
        },
        send(opts) {
          const expertId = opts.expertId;
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                kind: "error" as const,
                expertId,
                error: { code: "PROVIDER_ERROR" as const, message: "boom" },
                recoverable: false,
              };
            },
          };
        },
      };

      let out = "";
      let err = "";
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: (s) => (err += s),
        engineFactory: () => failingEngine,
        inputProvider: () => scriptedInput(["help me", "exit"]),
      });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);

      // User turn must be persisted even when the response failed (PRD §F4).
      await withRepo(env, async (repo) => {
        const session = await repo.findActiveSession("expert", "dahlia-cto");
        const turns = await repo.getTurns(session?.id ?? "");
        expect(turns.some((t) => t.role === "user" && t.content === "help me")).toBe(true);
        // No expert turn was saved (the response failed).
        expect(turns.some((t) => t.role === "expert")).toBe(false);
      });
      // The loop continued past the failure to the second scripted line.
      expect(out).toMatch(/Conversation saved/i);
      // A user-facing warning was emitted somewhere.
      expect(out + err).toMatch(/Failed to get response/i);
    });
  });
});
