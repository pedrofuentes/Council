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
  buildPanelTurnPrompt,
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

    it("lists active and archived sessions in a table with their statuses", async () => {
      await seedExpert(env);
      let activeId = "";
      let archivedId = "";
      await withRepo(env, async (repo) => {
        const a = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        activeId = a.id;
        await repo.addTurn({ chatId: a.id, role: "user", content: "hi" });
        const b = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        archivedId = b.id;
        await repo.archiveSession(b.id);
      });
      let out = "";
      const cmd = buildChatCommand({ write: (s) => (out += s) });
      await cmd.parseAsync(["node", "council-chat", "--list"]);
      // Both target slug and BOTH status values (as standalone column values,
      // not just substrings of the "last active" header) must appear.
      expect(out).toContain("dahlia-cto");
      // Count "active" occurrences: the header text "last active" contributes
      // one, the active-session status column contributes another. Without
      // the active session, we'd get exactly 1 (header only).
      const activeCount = (out.match(/active/g) ?? []).length;
      expect(activeCount).toBeGreaterThanOrEqual(2);
      expect(out).toMatch(/\barchived\b/);
      // Two rows for the same target must be present.
      const slugCount = (out.match(/dahlia-cto/g) ?? []).length;
      expect(slugCount).toBe(2);
      void activeId;
      void archivedId;
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

    it("lists archived sessions only for the target, excluding active and foreign-target rows", async () => {
      await seedExpert(env);
      await seedExpert(env, {
        ...SAMPLE,
        slug: "other-expert",
        displayName: "Other Expert",
      });
      let archivedId = "";
      let activeId = "";
      let foreignArchivedId = "";
      await withRepo(env, async (repo) => {
        const a = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        archivedId = a.id;
        await repo.archiveSession(a.id);
        const b = await repo.createSession({ targetType: "expert", targetSlug: "dahlia-cto" });
        activeId = b.id;
        await repo.addTurn({ chatId: b.id, role: "user", content: "active" });
        const c = await repo.createSession({ targetType: "expert", targetSlug: "other-expert" });
        foreignArchivedId = c.id;
        await repo.archiveSession(c.id);
      });
      let out = "";
      const cmd = buildChatCommand({ write: (s) => (out += s) });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--history"]);
      // Target archived session present.
      expect(out).toContain(archivedId);
      // Active session for target absent.
      expect(out).not.toContain(activeId);
      // Foreign-target archived session absent.
      expect(out).not.toContain(foreignArchivedId);
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
      // a non-recoverable error event.
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

    it("on recoverable engine error: retries once and persists a single clean expert turn", async () => {
      await seedExpert(env);
      let out = "";

      // Engine fails recoverably on the first send() and succeeds on the
      // second. Counts send calls; the first attempt yields a partial
      // delta then a recoverable error, the retry yields a complete
      // response. The chat command must (a) call send() exactly twice,
      // (b) persist exactly one expert turn with the retry's content
      // only — NOT the concatenation of partial + retry.
      let sendCalls = 0;
      const retryingEngine: CouncilEngine = {
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
          sendCalls += 1;
          const isFirst = sendCalls === 1;
          return {
            async *[Symbol.asyncIterator]() {
              if (isFirst) {
                yield { kind: "message.delta" as const, expertId, text: "PARTIAL-" };
                yield {
                  kind: "error" as const,
                  expertId,
                  error: { code: "NETWORK" as const, message: "transient" },
                  recoverable: true,
                };
              } else {
                yield { kind: "message.delta" as const, expertId, text: "FINAL-OK" };
                yield {
                  kind: "message.complete" as const,
                  expertId,
                  response: { latencyMs: 1 },
                };
              }
            },
          };
        },
      };

      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => retryingEngine,
        inputProvider: () => scriptedInput(["question?", "exit"]),
      });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);

      expect(sendCalls).toBe(2);
      // The partial first-attempt delta must NOT be rendered to stdout —
      // doing so would double-render the response on retry.
      expect(out).not.toContain("PARTIAL-");
      expect(out).toContain("FINAL-OK");
      const finalCount = (out.match(/FINAL-OK/g) ?? []).length;
      expect(finalCount).toBe(1);
      await withRepo(env, async (repo) => {
        const session = await repo.findActiveSession("expert", "dahlia-cto");
        const turns = await repo.getTurns(session?.id ?? "");
        const expertTurns = turns.filter((t) => t.role === "expert");
        expect(expertTurns.length).toBe(1);
        // The persisted expert turn must contain ONLY the retry's
        // content — the partial first attempt must not leak into it.
        expect(expertTurns[0]?.content).toBe("FINAL-OK");
        expect(expertTurns[0]?.content).not.toContain("PARTIAL");
      });
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// Panel chat mode (Roadmap 5.4)
// ──────────────────────────────────────────────────────────────────────

const PANEL_EXPERT_A: ExpertDefinition = {
  slug: "panel-a",
  displayName: "Alice (Architect)",
  role: "Systems architect",
  expertise: {
    weightedEvidence: ["postmortems"],
    referenceCases: [],
    notExpertIn: [],
  },
  epistemicStance: "Engineering rigor",
  kind: "generic",
};

const PANEL_EXPERT_B: ExpertDefinition = {
  slug: "panel-b",
  displayName: "Bob (Builder)",
  role: "Implementation lead",
  expertise: {
    weightedEvidence: ["shipping cadence"],
    referenceCases: [],
    notExpertIn: [],
  },
  epistemicStance: "Pragmatist",
  kind: "generic",
};

async function writeUserPanel(
  env: TestEnv,
  name: string,
  experts: readonly string[],
  description = "Test panel",
): Promise<void> {
  const dir = path.join(env.dataHome, "panels");
  await fs.mkdir(dir, { recursive: true });
  const lines = [
    `name: ${name}`,
    `description: ${description}`,
    "experts:",
    ...experts.map((s) => `  - ${s}`),
  ];
  await fs.writeFile(path.join(dir, `${name}.yaml`), lines.join("\n") + "\n", "utf-8");
}

describe("buildPanelTurnPrompt (pure)", () => {
  it("returns just the user message when there is no history", () => {
    const out = buildPanelTurnPrompt({
      history: [],
      userMessage: "Kickoff",
      expertNames: new Map([["panel-a", "Alice (Architect)"]]),
    });
    expect(out).toBe("Kickoff");
  });

  it("labels each prior turn by speaker and appends the new user message", () => {
    const history: readonly ChatTurn[] = [
      {
        id: "t1",
        chatId: "c1",
        seq: 1,
        role: "user",
        expertSlug: null,
        content: "Plan?",
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
        expertSlug: "panel-a",
        content: "Start with the schema.",
        isMention: false,
        tokensIn: null,
        tokensOut: null,
        createdAt: "2024-01-01T00:00:01Z",
      },
      {
        id: "t3",
        chatId: "c1",
        seq: 3,
        role: "expert",
        expertSlug: "panel-b",
        content: "Ship the API first.",
        isMention: false,
        tokensIn: null,
        tokensOut: null,
        createdAt: "2024-01-01T00:00:02Z",
      },
    ];
    const out = buildPanelTurnPrompt({
      history,
      userMessage: "OK what next?",
      expertNames: new Map([
        ["panel-a", "Alice (Architect)"],
        ["panel-b", "Bob (Builder)"],
      ]),
    });
    expect(out).toContain("PRIOR CONVERSATION");
    expect(out).toContain("User: Plan?");
    expect(out).toContain("Alice (Architect): Start with the schema.");
    expect(out).toContain("Bob (Builder): Ship the API first.");
    expect(out).toContain("OK what next?");
    expect(out.indexOf("Ship the API first.")).toBeLessThan(out.indexOf("OK what next?"));
  });
});

describe("panel chat mode", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  async function seedTwoExperts(): Promise<void> {
    await seedExpert(env, PANEL_EXPERT_A);
    await seedExpert(env, PANEL_EXPERT_B);
  }

  it("falls back to panel resolution when the target is not an expert slug", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "my-panel", ["panel-a", "panel-b"]);

    let out = "";
    const cmd = buildChatCommand({
      write: (s) => (out += s),
      writeError: () => undefined,
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "my-panel", "--engine", "mock"]);

    expect(out).toMatch(/Starting panel chat/i);
    expect(out).toMatch(/2 experts/i);

    await withRepo(env, async (repo) => {
      const session = await repo.findActiveSession("panel", "my-panel");
      expect(session).toBeDefined();
      expect(session?.targetType).toBe("panel");
      expect(session?.targetSlug).toBe("my-panel");
    });
  });

  it("errors when target is neither an expert slug nor a panel", async () => {
    let err = "";
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: (s) => (err += s),
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput([]),
    });
    await expect(
      cmd.parseAsync(["node", "council-chat", "nope", "--engine", "mock"]),
    ).rejects.toThrow(/not found/i);
    expect(err).toMatch(/not found/i);
  });

  it("each expert responds to every user message; turns are persisted with expertSlug", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "duo", ["panel-a", "panel-b"]);

    let out = "";
    const cmd = buildChatCommand({
      write: (s) => (out += s),
      writeError: () => undefined,
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["hello panel", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "duo", "--engine", "mock"]);

    await withRepo(env, async (repo) => {
      const session = await repo.findActiveSession("panel", "duo");
      expect(session).toBeDefined();
      const turns = await repo.getTurns(session?.id ?? "");
      // 1 user turn + 2 expert turns (one per expert).
      expect(turns.length).toBe(3);
      expect(turns[0]?.role).toBe("user");
      expect(turns[0]?.content).toBe("hello panel");
      expect(turns[1]?.role).toBe("expert");
      expect(turns[2]?.role).toBe("expert");
      const expertSlugs = new Set(turns.filter((t) => t.role === "expert").map((t) => t.expertSlug));
      expect(expertSlugs.has("panel-a")).toBe(true);
      expect(expertSlugs.has("panel-b")).toBe(true);
    });
  });

  it("warns when a referenced expert slug is missing from the library and continues", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "with-gap", ["panel-a", "panel-b", "ghost"]);

    let out = "";
    let err = "";
    const cmd = buildChatCommand({
      write: (s) => (out += s),
      writeError: (s) => (err += s),
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "with-gap", "--engine", "mock"]);

    const combined = out + err;
    expect(combined).toMatch(/ghost/);
    expect(combined).toMatch(/not found/i);
    expect(combined).toMatch(/Continuing with 2 of 3 experts|2 of 3/i);
  });

  it("errors when no panel experts are resolvable", async () => {
    await writeUserPanel(env, "empty-panel", ["ghost-1", "ghost-2"]);

    let err = "";
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: (s) => (err += s),
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput([]),
    });
    await expect(
      cmd.parseAsync(["node", "council-chat", "empty-panel", "--engine", "mock"]),
    ).rejects.toThrow(/no available experts/i);
    expect(err).toMatch(/no available experts/i);
  });

  it("resumes an existing active panel session with a banner", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "resume-panel", ["panel-a", "panel-b"]);
    await withRepo(env, async (repo) => {
      const s = await repo.createSession({ targetType: "panel", targetSlug: "resume-panel" });
      await repo.addTurn({ chatId: s.id, role: "user", content: "earlier" });
      await repo.addTurn({
        chatId: s.id,
        role: "expert",
        expertSlug: "panel-a",
        content: "earlier reply",
      });
    });

    let out = "";
    const cmd = buildChatCommand({
      write: (s) => (out += s),
      writeError: () => undefined,
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "resume-panel", "--engine", "mock"]);
    expect(out).toMatch(/Resuming panel chat/i);
    expect(out).toMatch(/2 messages/i);
  });

  it("when one expert fails, the others still respond and a warning is shown", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "mixed-fail", ["panel-a", "panel-b"]);

    // Build a fake engine: first registered expert fails non-recoverably on send,
    // second succeeds. We track addExpert calls to assign behavior by registration
    // order (which mirrors the panel's expert order).
    let registered = 0;
    const failingSlugs = new Set<string>();
    const engine: CouncilEngine = {
      async start(): Promise<void> { /* ok */ },
      async stop(): Promise<void> { /* ok */ },
      async addExpert(spec): Promise<void> {
        if (registered === 0) failingSlugs.add(spec.id);
        registered += 1;
      },
      async removeExpert(): Promise<void> { /* ok */ },
      async listModels(): Promise<readonly string[]> {
        return ["mock"];
      },
      send(opts) {
        const expertId = opts.expertId;
        const shouldFail = failingSlugs.has(expertId);
        return {
          async *[Symbol.asyncIterator]() {
            if (shouldFail) {
              yield {
                kind: "error" as const,
                expertId,
                error: { code: "PROVIDER_ERROR" as const, message: "boom" },
                recoverable: false,
              };
            } else {
              yield { kind: "message.delta" as const, expertId, text: "OK-RESPONSE" };
              yield {
                kind: "message.complete" as const,
                expertId,
                response: { latencyMs: 1 },
              };
            }
          },
        };
      },
    };

    let out = "";
    let err = "";
    const cmd = buildChatCommand({
      write: (s) => (out += s),
      writeError: (s) => (err += s),
      engineFactory: () => engine,
      inputProvider: () => scriptedInput(["help me", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "mixed-fail", "--engine", "mock"]);

    const combined = out + err;
    expect(combined).toMatch(/could not respond|1 of 2 experts responded|1 of 2/i);

    await withRepo(env, async (repo) => {
      const session = await repo.findActiveSession("panel", "mixed-fail");
      const turns = await repo.getTurns(session?.id ?? "");
      const expertTurns = turns.filter((t) => t.role === "expert");
      expect(expertTurns.length).toBe(1);
      expect(expertTurns[0]?.content).toContain("OK-RESPONSE");
    });
  });

  it("when all experts fail, no expert turns are saved and a clear warning is shown", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "all-fail", ["panel-a", "panel-b"]);

    const engine: CouncilEngine = {
      async start(): Promise<void> { /* ok */ },
      async stop(): Promise<void> { /* ok */ },
      async addExpert(): Promise<void> { /* ok */ },
      async removeExpert(): Promise<void> { /* ok */ },
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
      engineFactory: () => engine,
      inputProvider: () => scriptedInput(["help", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "all-fail", "--engine", "mock"]);

    expect(out + err).toMatch(/No experts could respond/i);
    await withRepo(env, async (repo) => {
      const session = await repo.findActiveSession("panel", "all-fail");
      const turns = await repo.getTurns(session?.id ?? "");
      // User turn saved, no expert turns.
      expect(turns.filter((t) => t.role === "user").length).toBe(1);
      expect(turns.filter((t) => t.role === "expert").length).toBe(0);
    });
  });

  it("--list shows panel chat sessions alongside expert chats", async () => {
    await seedTwoExperts();
    await withRepo(env, async (repo) => {
      await repo.createSession({ targetType: "expert", targetSlug: "panel-a" });
      await repo.createSession({ targetType: "panel", targetSlug: "duo" });
    });

    let out = "";
    const cmd = buildChatCommand({ write: (s) => (out += s) });
    await cmd.parseAsync(["node", "council-chat", "--list"]);
    expect(out).toContain("panel-a");
    expect(out).toContain("duo");
  });

  it("--new archives the existing active panel session and starts fresh", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "renew-panel", ["panel-a", "panel-b"]);
    let priorId = "";
    await withRepo(env, async (repo) => {
      const s = await repo.createSession({ targetType: "panel", targetSlug: "renew-panel" });
      priorId = s.id;
      await repo.addTurn({ chatId: s.id, role: "user", content: "old" });
    });

    let out = "";
    const cmd = buildChatCommand({
      write: (s) => (out += s),
      writeError: () => undefined,
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["/quit"]),
    });
    await cmd.parseAsync([
      "node",
      "council-chat",
      "renew-panel",
      "--engine",
      "mock",
      "--new",
    ]);
    expect(out).toMatch(/archived/i);

    await withRepo(env, async (repo) => {
      const prior = await repo.findSessionById(priorId);
      expect(prior?.status).toBe("archived");
      const active = await repo.findActiveSession("panel", "renew-panel");
      expect(active).toBeDefined();
      expect(active?.id).not.toBe(priorId);
    });
  });

  it("--new does NOT archive the prior panel session when engine startup fails", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "atomic-panel", ["panel-a", "panel-b"]);
    let priorId = "";
    await withRepo(env, async (repo) => {
      const s = await repo.createSession({ targetType: "panel", targetSlug: "atomic-panel" });
      priorId = s.id;
      await repo.addTurn({ chatId: s.id, role: "user", content: "old" });
    });

    // Engine that fails on the first addExpert call (i.e. registering the
    // first panel member) — startup-phase failure.
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
        "atomic-panel",
        "--engine",
        "mock",
        "--new",
      ]),
    ).rejects.toThrow();

    await withRepo(env, async (repo) => {
      const prior = await repo.findSessionById(priorId);
      // Atomicity: prior session must remain active when startup fails.
      expect(prior?.status).toBe("active");
    });
  });

  it("retries a panel expert on a recoverable error and persists only the retry's content", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "retry-panel", ["panel-a", "panel-b"]);

    // First registered expert: send #1 fails recoverably with a partial
    // delta, send #2 succeeds. Second registered expert: always succeeds.
    // The chat loop must call send() exactly twice for the flaky expert,
    // not stream the first attempt's partial delta, and persist only the
    // retry's content.
    const failingIds = new Set<string>();
    let registered = 0;
    const sendCalls = new Map<string, number>();
    const engine: CouncilEngine = {
      async start(): Promise<void> {
        /* ok */
      },
      async stop(): Promise<void> {
        /* ok */
      },
      async addExpert(spec): Promise<void> {
        if (registered === 0) failingIds.add(spec.id);
        registered += 1;
      },
      async removeExpert(): Promise<void> {
        /* ok */
      },
      async listModels(): Promise<readonly string[]> {
        return ["mock"];
      },
      send(opts) {
        const expertId = opts.expertId;
        const n = (sendCalls.get(expertId) ?? 0) + 1;
        sendCalls.set(expertId, n);
        const isFlaky = failingIds.has(expertId);
        const flakyFirstAttempt = isFlaky && n === 1;
        return {
          async *[Symbol.asyncIterator]() {
            if (flakyFirstAttempt) {
              yield {
                kind: "message.delta" as const,
                expertId,
                text: "PARTIAL-",
              };
              yield {
                kind: "error" as const,
                expertId,
                error: { code: "NETWORK" as const, message: "transient" },
                recoverable: true,
              };
              return;
            }
            const text = isFlaky ? "RECOVERED-OK" : "STEADY-OK";
            yield { kind: "message.delta" as const, expertId, text };
            yield {
              kind: "message.complete" as const,
              expertId,
              response: { latencyMs: 1 },
            };
          },
        };
      },
    };

    let out = "";
    const cmd = buildChatCommand({
      write: (s) => (out += s),
      writeError: () => undefined,
      engineFactory: () => engine,
      inputProvider: () => scriptedInput(["question?", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "retry-panel", "--engine", "mock"]);

    // The flaky expert's first attempt's partial delta must not leak.
    expect(out).not.toContain("PARTIAL-");
    expect(out).toContain("RECOVERED-OK");
    expect(out).toContain("STEADY-OK");

    // The flaky expert must have been called exactly twice; the other once.
    const callCounts = Array.from(sendCalls.values()).sort();
    expect(callCounts).toEqual([1, 2]);

    await withRepo(env, async (repo) => {
      const session = await repo.findActiveSession("panel", "retry-panel");
      const turns = await repo.getTurns(session?.id ?? "");
      const expertTurns = turns.filter((t) => t.role === "expert");
      expect(expertTurns.length).toBe(2);
      const flakyTurn = expertTurns.find((t) => t.content.includes("RECOVERED"));
      expect(flakyTurn).toBeDefined();
      // The partial first attempt must not leak into the persisted turn.
      expect(flakyTurn?.content).toBe("RECOVERED-OK");
      expect(flakyTurn?.content).not.toContain("PARTIAL");
    });
  });

  it("distinguishes empty responses from engine errors in the panel aggregate summary", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "empty-vs-error", ["panel-a", "panel-b"]);

    // First expert returns an empty stream (no deltas, no error event).
    // Second expert succeeds normally. The aggregate summary must NOT
    // claim an engine error for the empty case — it should call it
    // out separately or use neutral wording.
    let registered = 0;
    const emptyIds = new Set<string>();
    const engine: CouncilEngine = {
      async start(): Promise<void> {
        /* ok */
      },
      async stop(): Promise<void> {
        /* ok */
      },
      async addExpert(spec): Promise<void> {
        if (registered === 0) emptyIds.add(spec.id);
        registered += 1;
      },
      async removeExpert(): Promise<void> {
        /* ok */
      },
      async listModels(): Promise<readonly string[]> {
        return ["mock"];
      },
      send(opts) {
        const expertId = opts.expertId;
        const isEmpty = emptyIds.has(expertId);
        return {
          async *[Symbol.asyncIterator]() {
            if (isEmpty) {
              // No deltas, no errors — just a clean completion event.
              yield {
                kind: "message.complete" as const,
                expertId,
                response: { latencyMs: 1 },
              };
              return;
            }
            yield { kind: "message.delta" as const, expertId, text: "OK-RESPONSE" };
            yield {
              kind: "message.complete" as const,
              expertId,
              response: { latencyMs: 1 },
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
      engineFactory: () => engine,
      inputProvider: () => scriptedInput(["hi", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "empty-vs-error", "--engine", "mock"]);

    const combined = out + err;
    // Empty case must be surfaced honestly.
    expect(combined).toMatch(/empty response/i);
    // No actual engine errors occurred — the aggregate must NOT claim one.
    expect(combined).not.toMatch(/engine error/i);
    // The non-empty expert's response is still rendered + persisted.
    expect(out).toContain("OK-RESPONSE");
  });

  it("reports all-empty panel turns as empty (not as a connection failure)", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "all-empty", ["panel-a", "panel-b"]);

    // Both experts return empty streams (clean completion, no deltas, no
    // errors). Aggregate must not claim a connection/engine error.
    const engine: CouncilEngine = {
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
              kind: "message.complete" as const,
              expertId,
              response: { latencyMs: 1 },
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
      engineFactory: () => engine,
      inputProvider: () => scriptedInput(["hi", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "all-empty", "--engine", "mock"]);

    const combined = out + err;
    // Honest wording: empty responses, not a connection failure.
    expect(combined).toMatch(/empty response/i);
    expect(combined).not.toMatch(/check your connection/i);
    expect(combined).not.toMatch(/engine error/i);
  });

  it("--history filters archived sessions by resolved target type (expert vs panel collision)", async () => {
    // An expert and a panel both named "shared". `council chat shared
    // --history` must NOT mix the archived panel session into the
    // expert-history view.
    await seedExpert(env, { ...PANEL_EXPERT_A, slug: "shared", displayName: "Shared Expert" });
    await writeUserPanel(env, "shared", ["panel-a"]);
    await seedExpert(env, PANEL_EXPERT_A);

    let expertArchivedId = "";
    let panelArchivedId = "";
    await withRepo(env, async (repo) => {
      const a = await repo.createSession({ targetType: "expert", targetSlug: "shared" });
      expertArchivedId = a.id;
      await repo.archiveSession(a.id);
      const b = await repo.createSession({ targetType: "panel", targetSlug: "shared" });
      panelArchivedId = b.id;
      await repo.archiveSession(b.id);
    });

    let out = "";
    const cmd = buildChatCommand({
      write: (s) => (out += s),
      writeError: () => undefined,
    });
    await cmd.parseAsync(["node", "council-chat", "shared", "--history"]);

    // library.get() resolves first → expert wins → show only expert
    // archives. The panel archive must not leak in.
    expect(out).toContain(expertArchivedId);
    expect(out).not.toContain(panelArchivedId);
  });
});

// ──────────────────────────────────────────────────────────────────────
// @mention + @convene routing (Roadmap 5.5 + 5.6)
// ──────────────────────────────────────────────────────────────────────

describe("panel chat — @mention routing", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  async function seedTwoExperts(): Promise<void> {
    await seedExpert(env, PANEL_EXPERT_A);
    await seedExpert(env, PANEL_EXPERT_B);
  }

  it("@mention routes to only the targeted expert; turn marked isMention", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "duo", ["panel-a", "panel-b"]);

    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["@panel-a what's up?", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "duo", "--engine", "mock"]);

    await withRepo(env, async (repo) => {
      const session = await repo.findActiveSession("panel", "duo");
      expect(session).toBeDefined();
      const turns = await repo.getTurns(session?.id ?? "");
      const expertTurns = turns.filter((t) => t.role === "expert");
      // Only the mentioned expert responds.
      expect(expertTurns.length).toBe(1);
      expect(expertTurns[0]?.expertSlug).toBe("panel-a");
      expect(expertTurns[0]?.isMention).toBe(true);
      // User content has the @prefix stripped before being saved.
      const userTurns = turns.filter((t) => t.role === "user");
      expect(userTurns[0]?.content).toBe("what's up?");
      expect(userTurns[0]?.isMention).toBe(true);
    });
  });

  it("multiple @mentions route to all targets in panel order", async () => {
    await seedTwoExperts();
    // Panel declares panel-a first, panel-b second. The user mentions
    // them in reverse — responses should still come back in panel order.
    await writeUserPanel(env, "duo2", ["panel-a", "panel-b"]);

    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["@panel-b @panel-a thoughts?", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "duo2", "--engine", "mock"]);

    await withRepo(env, async (repo) => {
      const session = await repo.findActiveSession("panel", "duo2");
      const turns = await repo.getTurns(session?.id ?? "");
      const expertTurns = turns.filter((t) => t.role === "expert");
      expect(expertTurns.length).toBe(2);
      // Order matches panel declaration order, not mention order.
      expect(expertTurns[0]?.expertSlug).toBe("panel-a");
      expect(expertTurns[1]?.expertSlug).toBe("panel-b");
      expect(expertTurns[0]?.isMention).toBe(true);
      expect(expertTurns[1]?.isMention).toBe(true);
    });
  });

  it("general (no @mention) routes to every expert (isMention=false)", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "all-respond", ["panel-a", "panel-b"]);

    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["plain question", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "all-respond", "--engine", "mock"]);

    await withRepo(env, async (repo) => {
      const session = await repo.findActiveSession("panel", "all-respond");
      const turns = await repo.getTurns(session?.id ?? "");
      const expertTurns = turns.filter((t) => t.role === "expert");
      expect(expertTurns.length).toBe(2);
      expect(expertTurns.every((t) => t.isMention === false)).toBe(true);
    });
  });

  it("unknown @slug surfaces the error and does NOT persist the user turn", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "panel3", ["panel-a", "panel-b"]);

    let err = "";
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: (s) => (err += s),
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["@ghost hi", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "panel3", "--engine", "mock"]);

    expect(err).toMatch(/Expert "ghost" is not in this panel/);
    expect(err).toMatch(/panel-a, panel-b/);

    await withRepo(env, async (repo) => {
      const session = await repo.findActiveSession("panel", "panel3");
      const turns = await repo.getTurns(session?.id ?? "");
      // Malformed input is rejected pre-persist so the user can retry
      // without leaving a stray fragment in the conversation.
      expect(turns.length).toBe(0);
    });
  });

  it("non-mentioned experts see the @mention exchange in their context on next turn", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "ctx", ["panel-a", "panel-b"]);

    const engine = new MockEngine();
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => engine,
      inputProvider: () =>
        scriptedInput([
          "@panel-a tell me one fact",
          "now everyone weigh in",
          "/quit",
        ]),
    });
    await cmd.parseAsync(["node", "council-chat", "ctx", "--engine", "mock"]);

    // After turn 1: only panel-a sent. After turn 2 (general): both sent.
    // The crucial assertion is that turn-2 prompts include panel-a's
    // prior reply — i.e. the non-mentioned expert sees the @mention
    // exchange in its context.
    const promptsWithPriorReply = engine.sentPrompts.filter((p) =>
      p.prompt.includes("[mock response from"),
    );
    // Both turn-2 sends carry the prior reply (1 per panelist).
    expect(promptsWithPriorReply.length).toBe(2);
    expect(promptsWithPriorReply.every((p) => p.prompt.includes("tell me one fact"))).toBe(true);
  });

  it("@mention in 1:1 expert chat is processed normally (parser bypassed)", async () => {
    await seedExpert(env);

    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => new MockEngine(),
      // The literal "@nonexistent foo" should NOT throw in 1:1 chat —
      // there's no panel context, so the parser isn't invoked.
      inputProvider: () => scriptedInput(["@nonexistent foo", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", SAMPLE.slug, "--engine", "mock"]);

    await withRepo(env, async (repo) => {
      const session = await repo.findActiveSession("expert", SAMPLE.slug);
      const turns = await repo.getTurns(session?.id ?? "");
      // User + 1 expert reply, both persisted normally.
      expect(turns.length).toBe(2);
      expect(turns[0]?.content).toBe("@nonexistent foo");
      expect(turns[0]?.isMention).toBe(false);
    });
  });
});

describe("panel chat — @convene structured debate", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  async function seedTwoExperts(): Promise<void> {
    await seedExpert(env, PANEL_EXPERT_A);
    await seedExpert(env, PANEL_EXPERT_B);
  }

  it("@convene triggers a structured debate and persists each debate turn", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "deb", ["panel-a", "panel-b"]);

    let out = "";
    const cmd = buildChatCommand({
      write: (s) => (out += s),
      writeError: () => undefined,
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["@convene should we ship?", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "deb", "--engine", "mock"]);

    expect(out).toMatch(/Starting structured deliberation/i);
    expect(out).toMatch(/Structured deliberation complete/i);

    await withRepo(env, async (repo) => {
      const session = await repo.findActiveSession("panel", "deb");
      const turns = await repo.getTurns(session?.id ?? "");
      // 1 user turn (the @convene command) + 4 phases × 2 experts = 8
      // debate turns persisted as chat turns.
      const userTurns = turns.filter((t) => t.role === "user");
      const expertTurns = turns.filter((t) => t.role === "expert");
      expect(userTurns.length).toBe(1);
      expect(userTurns[0]?.content).toBe("should we ship?");
      expect(expertTurns.length).toBe(8);
      // Both experts produced turns.
      const slugs = new Set(expertTurns.map((t) => t.expertSlug));
      expect(slugs.has("panel-a")).toBe(true);
      expect(slugs.has("panel-b")).toBe(true);
    });
  });

  it("@convene with no topic surfaces an error to the user", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "deb2", ["panel-a", "panel-b"]);

    let err = "";
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: (s) => (err += s),
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["@convene", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "deb2", "--engine", "mock"]);

    expect(err).toMatch(/@convene requires a topic/i);
    await withRepo(env, async (repo) => {
      const session = await repo.findActiveSession("panel", "deb2");
      const turns = await repo.getTurns(session?.id ?? "");
      expect(turns.length).toBe(0);
    });
  });

  it("@convene partial failure: persists turns from completed phases and resumes chat", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "deb3", ["panel-a", "panel-b"]);

    // First two sends succeed (opening turns), all subsequent sends
    // fail. Debate continues through all phases (errors are non-
    // terminal at the debate level), so we expect 2 successful turns +
    // a partial-completion notice from the chat command.
    let sendCount = 0;
    const engine: CouncilEngine = {
      async start(): Promise<void> { /* ok */ },
      async stop(): Promise<void> { /* ok */ },
      async addExpert(): Promise<void> { /* ok */ },
      async removeExpert(): Promise<void> { /* ok */ },
      async listModels(): Promise<readonly string[]> {
        return ["mock"];
      },
      send(opts) {
        const expertId = opts.expertId;
        const n = ++sendCount;
        return {
          async *[Symbol.asyncIterator]() {
            if (n > 2) {
              yield {
                kind: "error" as const,
                expertId,
                error: { code: "PROVIDER_ERROR" as const, message: "boom" },
                recoverable: false,
              };
              return;
            }
            yield { kind: "message.delta" as const, expertId, text: `phase-resp-${n}` };
            yield {
              kind: "message.complete" as const,
              expertId,
              response: { latencyMs: 1 },
            };
          },
        };
      },
    };

    let out = "";
    const cmd = buildChatCommand({
      write: (s) => (out += s),
      writeError: () => undefined,
      engineFactory: () => engine,
      inputProvider: () => scriptedInput(["@convene topic", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "deb3", "--engine", "mock"]);

    // Even with widespread failures, the structured run completes — but
    // the chat session must still resume cleanly (no thrown exception
    // bubbles out of the loop).
    expect(out).toMatch(/Structured deliberation/i);
    await withRepo(env, async (repo) => {
      const session = await repo.findActiveSession("panel", "deb3");
      const turns = await repo.getTurns(session?.id ?? "");
      const expertTurns = turns.filter((t) => t.role === "expert");
      // Exactly the 2 successful sends got persisted.
      expect(expertTurns.length).toBe(2);
      expect(expertTurns[0]?.content).toContain("phase-resp-1");
      expect(expertTurns[1]?.content).toContain("phase-resp-2");
    });
  });

  it("@convene with a synchronously-throwing engine.send leaves no orphan user turn", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "deb4", ["panel-a", "panel-b"]);

    // Engine that throws synchronously from send() — propagates through
    // Debate.run() and bubbles into runInlineDebate's catch. The user
    // row for the @convene line must NOT be left dangling without any
    // expert response (Sentinel SR-PR-mention-1).
    const engine: CouncilEngine = {
      async start(): Promise<void> { /* ok */ },
      async stop(): Promise<void> { /* ok */ },
      async addExpert(): Promise<void> { /* ok */ },
      async removeExpert(): Promise<void> { /* ok */ },
      async listModels(): Promise<readonly string[]> {
        return ["mock"];
      },
      send(): never {
        throw new Error("send-blew-up");
      },
    };

    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => engine,
      inputProvider: () => scriptedInput(["@convene topic", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "deb4", "--engine", "mock"]);

    await withRepo(env, async (repo) => {
      const session = await repo.findActiveSession("panel", "deb4");
      const turns = await repo.getTurns(session?.id ?? "");
      // No expert turns produced AND no orphan user row.
      expect(turns.length).toBe(0);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────
// Persona expert — on-demand document processing (Roadmap 6.4)
// ──────────────────────────────────────────────────────────────────────

const PERSONA_SAMPLE: ExpertDefinition = {
  slug: "sarah-vp",
  displayName: "Sarah VP",
  role: "VP of Engineering",
  expertise: {
    weightedEvidence: ["delivery commitments"],
    referenceCases: [],
    notExpertIn: [],
  },
  epistemicStance: "Pragmatist focused on customer outcomes",
  kind: "persona",
  personaDescription: "VP of Engineering I report to",
};

async function seedPersonaWithDocs(
  env: TestEnv,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  await seedExpert(env, PERSONA_SAMPLE);
  const docsDir = path.join(env.dataHome, "experts", PERSONA_SAMPLE.slug, "docs");
  await fs.mkdir(docsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(docsDir, name), content);
  }
  return docsDir;
}

describe("persona expert — on-demand document processing", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  it("processes new docs on first chat invocation, tracks them in the DB, and shows progress", async () => {
    await seedPersonaWithDocs(env, {
      "memo.md": "# Memo\n\nShip incrementally; data over opinions.",
      "notes.txt": "Customer commitments come first.",
    });

    let out = "";
    const cmd = buildChatCommand({
      write: (s) => (out += s),
      writeError: () => undefined,
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", PERSONA_SAMPLE.slug, "--engine", "mock"]);

    // Documents tracked in expert_documents.
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new (await import(
        "../../../../src/memory/repositories/document-repository.js"
      )).DocumentRepository(db);
      const docs = await repo.findByExpert(PERSONA_SAMPLE.slug);
      expect(docs.length).toBe(2);
      expect(docs.every((d) => d.status === "processed")).toBe(true);
    } finally {
      await db.destroy();
    }

    // Progress UX surfaced to the user.
    expect(out.toLowerCase()).toMatch(/processing|document/);
  });

  it("skips re-processing on subsequent invocations when no docs changed", async () => {
    await seedPersonaWithDocs(env, {
      "memo.md": "# Memo\n\nstable content",
    });

    // First run — process.
    const cmd1 = buildChatCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["/quit"]),
    });
    await cmd1.parseAsync(["node", "council-chat", PERSONA_SAMPLE.slug, "--engine", "mock"]);

    // Second run — no docs changed; processing should be skipped.
    let out2 = "";
    const cmd2 = buildChatCommand({
      write: (s) => (out2 += s),
      writeError: () => undefined,
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["/quit"]),
    });
    await cmd2.parseAsync(["node", "council-chat", PERSONA_SAMPLE.slug, "--engine", "mock"]);

    // No "processing N documents" line on the second run.
    expect(out2).not.toMatch(/processing \d+ document/i);
  });

  it("empty docs folder: surfaces info that the persona will work as a generic expert", async () => {
    await seedPersonaWithDocs(env, {});

    let out = "";
    const cmd = buildChatCommand({
      write: (s) => (out += s),
      writeError: () => undefined,
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", PERSONA_SAMPLE.slug, "--engine", "mock"]);

    // No documents tracked.
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new (await import(
        "../../../../src/memory/repositories/document-repository.js"
      )).DocumentRepository(db);
      const docs = await repo.findByExpert(PERSONA_SAMPLE.slug);
      expect(docs.length).toBe(0);
    } finally {
      await db.destroy();
    }

    // User informed the expert will operate without persona-specific docs.
    expect(out.toLowerCase()).toMatch(/no documents|generic|empty/);
  });

  it("generic experts skip the document-processing pipeline entirely", async () => {
    // Generic expert — no docs folder, no processing UX, chat runs normally.
    await seedExpert(env);
    let out = "";
    const cmd = buildChatCommand({
      write: (s) => (out += s),
      writeError: () => undefined,
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);
    expect(out).not.toMatch(/processing \d+ document/i);
    expect(out).not.toMatch(/persona profile/i);
  });
});
