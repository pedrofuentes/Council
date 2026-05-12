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
});
