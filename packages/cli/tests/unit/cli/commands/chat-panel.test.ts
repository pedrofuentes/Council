/**
 * Part of the `council chat` CLI test suite.
 * Split from chat.test.ts to keep individual files under the Vitest
 * forks-pool worker IPC threshold (~60 tests / file).
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildChatCommand,
  buildPanelTurnPrompt,
  type ChatInputProvider,
} from "../../../../src/cli/commands/chat.js";
import { FileExpertLibrary } from "../../../../src/core/expert-library.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import type { ChatTurn } from "../../../../src/core/chat/chat-session.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { ChatRepository } from "../../../../src/memory/repositories/chat-repository.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

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
  await copyTemplateDb(path.join(home, "council.db"));
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

  it("loads an auto-composed panel from the persisted session definition when its template is absent", async () => {
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new PanelRepository(db);
      await repo.create({
        name: "composed-panel-2026-06-21T13:28:08",
        topic: "Choose the launch plan",
        copilotHome: path.join(env.home, "copilot"),
        configJson: JSON.stringify({
          template: "auto-template-that-was-never-saved",
          mode: "structured",
          engine: "mock",
          definition: {
            name: "Composed Launch Panel",
            description: "A one-off launch readiness panel",
            defaults: { mode: "structured", maxRounds: 2, model: "mock" },
            experts: [PANEL_EXPERT_A, PANEL_EXPERT_B],
          },
        }),
      });
    } finally {
      await db.destroy();
    }

    let out = "";
    let err = "";
    const cmd = buildChatCommand({
      write: (s) => (out += s),
      writeError: (s) => (err += s),
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["/quit"]),
    });

    await cmd.parseAsync([
      "node",
      "council-chat",
      "composed-panel-2026-06-21T13:28:08",
      "--engine",
      "mock",
    ]);

    expect(out).toMatch(/Starting panel chat/i);
    expect(out).toContain("Composed Launch Panel");
    expect(out).toMatch(/2 experts/i);
    expect(err).not.toMatch(/failed to load its template/i);
  });

  it("errors when a persisted panel has neither a loadable template nor a stored definition", async () => {
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new PanelRepository(db);
      await repo.create({
        name: "legacy-launch-panel",
        topic: "Choose the launch plan",
        copilotHome: path.join(env.home, "copilot"),
        configJson: JSON.stringify({
          template: "legacy-template-that-was-never-saved",
          mode: "structured",
          engine: "mock",
        }),
      });
    } finally {
      await db.destroy();
    }

    let err = "";
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: (s) => (err += s),
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput([]),
    });

    await expect(
      cmd.parseAsync(["node", "council-chat", "legacy-launch-panel", "--engine", "mock"]),
    ).rejects.toThrow(/Failed to load panel template for "legacy-launch-panel"/);
    expect(err).toContain('panel "legacy-launch-panel" exists in database');
    expect(err).toMatch(/failed to load its template/i);
    expect(err).toContain("legacy-template-that-was-never-saved");
  });

  it("shows an actionable recovery hint for legacy auto-composed sessions without stored definitions", async () => {
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new PanelRepository(db);
      await repo.create({
        name: "legacy-topic-panel",
        topic: "Decide the migration plan",
        copilotHome: path.join(env.home, "copilot"),
        configJson: JSON.stringify({
          template: "missing-legacy-topic-template",
          mode: "structured",
          engine: "mock",
        }),
      });
    } finally {
      await db.destroy();
    }

    let err = "";
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: (s) => (err += s),
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput([]),
    });

    await expect(
      cmd.parseAsync(["node", "council-chat", "legacy-topic-panel", "--engine", "mock"]),
    ).rejects.toThrow(/Failed to load panel template for "legacy-topic-panel"/);
    expect(err).toMatch(/predates persisted panel definitions/i);
    expect(err).toMatch(/re-run `council convene "Decide the migration plan"`/i);
  });

  it("collapses legacy recovery hint topics to one terminal line", async () => {
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new PanelRepository(db);
      await repo.create({
        name: "legacy-spoof-topic-panel",
        topic: "Ship now\r\n\u001B[31mspoof OK\u2028next line",
        copilotHome: path.join(env.home, "copilot"),
        configJson: JSON.stringify({
          template: "missing-legacy-spoof-template",
          mode: "structured",
          engine: "mock",
        }),
      });
    } finally {
      await db.destroy();
    }

    let err = "";
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: (s) => (err += s),
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput([]),
    });

    await expect(
      cmd.parseAsync(["node", "council-chat", "legacy-spoof-topic-panel", "--engine", "mock"]),
    ).rejects.toThrow(/Failed to load panel template for "legacy-spoof-topic-panel"/);
    expect(err).toContain('Re-run `council convene "Ship now spoof OK next line"`');
    expect(err).not.toContain("\r");
    expect(err).not.toContain("\u001B");
    expect(err).not.toContain("\u2028");
  });

  it("collapses legacy fallback panel targets to one terminal line", async () => {
    const maliciousTarget = "legacy\r\n\u001B[31mspoof\u2028panel";
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new PanelRepository(db);
      await repo.create({
        name: maliciousTarget,
        topic: "Choose the launch plan",
        copilotHome: path.join(env.home, "copilot"),
        configJson: JSON.stringify({
          template: "missing-malicious-target-template",
          mode: "structured",
          engine: "mock",
        }),
      });
    } finally {
      await db.destroy();
    }

    let err = "";
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: (s) => (err += s),
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput([]),
    });

    await expect(
      cmd.parseAsync(["node", "council-chat", maliciousTarget, "--engine", "mock"]),
    ).rejects.toThrow(/Failed to load panel template for "legacy spoof panel"/);
    expect(err).toContain('panel "legacy spoof panel" exists in database');
    expect(err).not.toContain("\r");
    expect(err).not.toContain("\u001B");
    expect(err).not.toContain("\u2028");
    expect(err).not.toContain("legacy\r\n");
  });

  it("errors when a persisted panel has an invalid stored definition", async () => {
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new PanelRepository(db);
      await repo.create({
        name: "invalid-stored-panel",
        topic: "Choose the launch plan",
        copilotHome: path.join(env.home, "copilot"),
        configJson: JSON.stringify({
          template: "missing-invalid-template",
          mode: "structured",
          engine: "mock",
          definition: {
            name: "Invalid Stored Panel",
            experts: [],
          },
        }),
      });
    } finally {
      await db.destroy();
    }

    let err = "";
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: (s) => (err += s),
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput([]),
    });

    await expect(
      cmd.parseAsync(["node", "council-chat", "invalid-stored-panel", "--engine", "mock"]),
    ).rejects.toThrow(/Failed to load panel template for "invalid-stored-panel"/);
    expect(err).toContain('Stored panel definition for "invalid-stored-panel" is invalid');
    expect(err).toMatch(/Too small|at least 1/i);
  });

  it("sanitizes the target before writing invalid stored-definition warnings", async () => {
    const maliciousTarget = "evil\u001B[31mpanel";
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new PanelRepository(db);
      await repo.create({
        name: maliciousTarget,
        topic: "Choose the launch plan",
        copilotHome: path.join(env.home, "copilot"),
        configJson: JSON.stringify({
          template: "missing-malicious-template",
          mode: "structured",
          engine: "mock",
          definition: {
            name: "Invalid Stored Panel",
            experts: [],
          },
        }),
      });
    } finally {
      await db.destroy();
    }

    let err = "";
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: (s) => (err += s),
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput([]),
    });

    await expect(
      cmd.parseAsync(["node", "council-chat", maliciousTarget, "--engine", "mock"]),
    ).rejects.toThrow(/Failed to load panel template/);
    expect(err).not.toContain("\u001B");
    expect(err).toContain('Stored panel definition for "evilpanel" is invalid');
  });

  it("collapses invalid stored-definition panel targets to one terminal line", async () => {
    const maliciousTarget = "stored\r\n\u001B[31mspoof\u2028panel";
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new PanelRepository(db);
      await repo.create({
        name: maliciousTarget,
        topic: "Choose the launch plan",
        copilotHome: path.join(env.home, "copilot"),
        configJson: JSON.stringify({
          template: "missing-malicious-stored-template",
          mode: "structured",
          engine: "mock",
          definition: {
            name: "Invalid Stored Panel",
            experts: [],
          },
        }),
      });
    } finally {
      await db.destroy();
    }

    let err = "";
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: (s) => (err += s),
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput([]),
    });

    await expect(
      cmd.parseAsync(["node", "council-chat", maliciousTarget, "--engine", "mock"]),
    ).rejects.toThrow(/Failed to load panel template/);
    expect(err).toContain('Stored panel definition for "stored spoof panel" is invalid');
    expect(err).not.toContain("\r");
    expect(err).not.toContain("\u001B");
    expect(err).not.toContain("\u2028");
    expect(err).not.toContain("stored\r\n");
  });

  it("sanitizes target and topic when a persisted panel omits its template name (#1481)", async () => {
    // Regression for the legacy branch where configJson has NO `template` key
    // (readTemplateName returns undefined), which is distinct from the
    // missing-template-FILE and invalid-stored-definition branches already
    // covered above. Both the echoed target and the recovery-hint topic must
    // be collapsed to a single terminal line — dropping `toSingleLineDisplay`
    // from either the target echo or `legacyPanelRecoveryHint` breaks this.
    const maliciousTarget = "omitted\r\n\u001B[31mspoof\u2028panel";
    const maliciousTopic = "Launch\r\n\u001B[32mfake OK\u2028next line";
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new PanelRepository(db);
      await repo.create({
        name: maliciousTarget,
        topic: maliciousTopic,
        copilotHome: path.join(env.home, "copilot"),
        // No `template` key — exercises the omitted-template recovery branch.
        configJson: JSON.stringify({
          mode: "structured",
          engine: "mock",
        }),
      });
    } finally {
      await db.destroy();
    }

    let err = "";
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: (s) => (err += s),
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput([]),
    });

    await expect(
      cmd.parseAsync(["node", "council-chat", maliciousTarget, "--engine", "mock"]),
    ).rejects.toThrow(/Failed to load panel template for "omitted spoof panel"/);
    // Proves this hit the omitted-template branch specifically.
    expect(err).toContain("has no template name in configJson");
    // Target echo sanitized + collapsed to one line.
    expect(err).toContain('panel "omitted spoof panel" exists in database');
    // Recovery-hint topic sanitized + collapsed to one line.
    expect(err).toContain('Re-run `council convene "Launch fake OK next line"`');
    // No raw control/terminal sequences survive in the diagnostic.
    expect(err).not.toContain("\u001B");
    expect(err).not.toContain("\r");
    expect(err).not.toContain("\u2028");
    expect(err).not.toContain("omitted\r\n");
    expect(err).not.toContain("Launch\r\n");
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
      const expertSlugs = new Set(
        turns.filter((t) => t.role === "expert").map((t) => t.expertSlug),
      );
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
      async start(): Promise<void> {
        /* ok */
      },
      async stop(): Promise<void> {
        /* ok */
      },
      async addExpert(spec): Promise<void> {
        if (registered === 0) failingSlugs.add(spec.id);
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
    await cmd.parseAsync(["node", "council-chat", "renew-panel", "--engine", "mock", "--new"]);
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
      cmd.parseAsync(["node", "council-chat", "atomic-panel", "--engine", "mock", "--new"]),
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

  it("retries a panel expert's empty response once and renders the retried content (T14)", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "retry-empty", ["panel-a", "panel-b"]);

    // panel-a returns an empty completion on its FIRST send, then real
    // content on the retry; panel-b is steady. The empty response must be
    // retried (not silently surfaced as empty) so the content wins.
    let registered = 0;
    const flakyEmptyIds = new Set<string>();
    const sendCalls = new Map<string, number>();
    const engine: CouncilEngine = {
      async start(): Promise<void> {
        /* ok */
      },
      async stop(): Promise<void> {
        /* ok */
      },
      async addExpert(spec): Promise<void> {
        if (registered === 0) flakyEmptyIds.add(spec.id);
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
        const emptyFirst = flakyEmptyIds.has(expertId) && n === 1;
        return {
          async *[Symbol.asyncIterator]() {
            if (emptyFirst) {
              yield { kind: "message.complete" as const, expertId, response: { latencyMs: 1 } };
              return;
            }
            const text = flakyEmptyIds.has(expertId) ? "RETRIED-OK" : "STEADY-OK";
            yield { kind: "message.delta" as const, expertId, text };
            yield { kind: "message.complete" as const, expertId, response: { latencyMs: 1 } };
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
    await cmd.parseAsync(["node", "council-chat", "retry-empty", "--engine", "mock"]);

    const combined = out + err;
    // The retried content is rendered and no empty warning is surfaced.
    expect(out).toContain("RETRIED-OK");
    expect(out).toContain("STEADY-OK");
    expect(combined).not.toMatch(/empty response/i);

    // The empty expert was retried exactly once (2 sends); the steady one once.
    const callCounts = Array.from(sendCalls.values()).sort();
    expect(callCounts).toEqual([1, 2]);

    // The retried content is persisted (not the empty first attempt).
    await withRepo(env, async (repo) => {
      const session = await repo.findActiveSession("panel", "retry-empty");
      const turns = await repo.getTurns(session?.id ?? "");
      const expertTurns = turns.filter((t) => t.role === "expert");
      expect(expertTurns.length).toBe(2);
      const retried = expertTurns.find((t) => t.content.includes("RETRIED-OK"));
      expect(retried?.content).toBe("RETRIED-OK");
    });
  });

  it("surfaces an 'after a retry' reason when a panel expert stays empty, keeping the N of M tally (T14)", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "empty-twice", ["panel-a", "panel-b"]);

    // panel-a returns empty on EVERY send (so the retry is also empty);
    // panel-b succeeds. The empty expert must be surfaced with a reason
    // that mentions the retry, and the "N of M" tally must still hold.
    let registered = 0;
    const emptyIds = new Set<string>();
    const sendCalls = new Map<string, number>();
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
        sendCalls.set(expertId, (sendCalls.get(expertId) ?? 0) + 1);
        const isEmpty = emptyIds.has(expertId);
        return {
          async *[Symbol.asyncIterator]() {
            if (isEmpty) {
              yield { kind: "message.complete" as const, expertId, response: { latencyMs: 1 } };
              return;
            }
            yield { kind: "message.delta" as const, expertId, text: "STEADY-OK" };
            yield { kind: "message.complete" as const, expertId, response: { latencyMs: 1 } };
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
    await cmd.parseAsync(["node", "council-chat", "empty-twice", "--engine", "mock"]);

    const combined = out + err;
    // Clear, honest wording that a retry was attempted.
    expect(combined).toMatch(/empty response after a retry/i);
    // Partial results preserved and the aggregate tally is intact.
    expect(out).toContain("STEADY-OK");
    expect(combined).toMatch(/1 of 2 experts responded/i);

    // The empty expert was retried once (2 sends); the steady one once.
    const callCounts = Array.from(sendCalls.values()).sort();
    expect(callCounts).toEqual([1, 2]);
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

  it("quoted display-name @mention errors and does NOT silently broadcast", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "panelq", ["panel-a", "panel-b"]);

    let err = "";
    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: (s) => (err += s),
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(['@"Alice (Architect)" hi there', "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "panelq", "--engine", "mock"]);

    expect(err).toMatch(/display[- ]name/i);

    await withRepo(env, async (repo) => {
      const session = await repo.findActiveSession("panel", "panelq");
      const turns = await repo.getTurns(session?.id ?? "");
      // Must NOT have broadcast to the panel: no user/expert turns persisted.
      expect(turns.length).toBe(0);
    });
  });

  it("startup banner lists the expert slugs so users know what to type", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "panelr", ["panel-a", "panel-b"]);

    let out = "";
    const cmd = buildChatCommand({
      write: (s) => (out += s),
      writeError: () => undefined,
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "panelr", "--engine", "mock"]);

    expect(out).toContain("@panel-a");
    expect(out).toContain("@panel-b");
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
        scriptedInput(["@panel-a tell me one fact", "now everyone weigh in", "/quit"]),
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

  it("@convene restores original (non-canary) expert systemMessage after the debate (T-09)", async () => {
    await seedTwoExperts();
    await writeUserPanel(env, "deb-canary", ["panel-a", "panel-b"]);

    // Custom engine that records every (op, id, systemMessage) tuple
    // so we can verify the swap+restore protocol leaves the outer chat
    // with the ORIGINAL system messages registered post-debate.
    const ops: { op: "add" | "remove"; id: string; sm?: string }[] = [];
    const expertSystemMessages = new Map<string, string>();
    const engine: CouncilEngine = {
      async start(): Promise<void> {
        /* ok */
      },
      async stop(): Promise<void> {
        /* ok */
      },
      async addExpert(spec): Promise<void> {
        ops.push({ op: "add", id: spec.id, sm: spec.systemMessage });
        expertSystemMessages.set(spec.id, spec.systemMessage);
      },
      async removeExpert(id): Promise<void> {
        ops.push({ op: "remove", id });
        expertSystemMessages.delete(id);
      },
      async listModels(): Promise<readonly string[]> {
        return ["mock"];
      },
      send(opts) {
        const expertId = opts.expertId;
        return {
          async *[Symbol.asyncIterator]() {
            yield { kind: "message.delta" as const, expertId, text: `resp-${expertId}` };
            yield {
              kind: "message.complete" as const,
              expertId,
              response: { latencyMs: 1 },
            };
          },
        };
      },
    };

    const cmd = buildChatCommand({
      write: () => undefined,
      writeError: () => undefined,
      engineFactory: () => engine,
      inputProvider: () => scriptedInput(["@convene canary check", "/quit"]),
    });
    await cmd.parseAsync(["node", "council-chat", "deb-canary", "--engine", "mock"]);

    // After @convene runs (and the outer chat continues to /quit), both
    // experts must be registered with their ORIGINAL systemMessage
    // (no canary suffix). The canary instruction text appears ONLY in
    // the systemMessages registered transiently during the debate.
    for (const [id, sm] of expertSystemMessages.entries()) {
      expect(sm, `expert ${id} systemMessage`).not.toMatch(/CANARY_/);
      expect(sm, `expert ${id} systemMessage`).not.toMatch(/confidential and must NEVER appear/);
    }

    // The canary specs were transiently registered during the debate
    // — at least one add op carries a canary in its systemMessage,
    // proving the swap actually happened (not a no-op).
    const canaryAdds = ops.filter((o) => o.op === "add" && o.sm?.includes("CANARY_"));
    expect(canaryAdds.length).toBeGreaterThan(0);
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
// Generic-expert unindexed-docs warning at panel/convene startup (#1103)
//
// The 1:1 chat path (expert-chat.ts -> maybeProcessPersonaDocs) warns when a
// GENERIC expert has files in experts/<slug>/docs/ that will never be indexed
// (generic experts do not run the document pipeline). Panel/convene startup
// must surface the SAME warning per generic member — previously it did not,
// because panel-chat only scans the panel's own managed docs dir
// (panels/<name>/docs) and never inspected each member's per-expert docs.
// ──────────────────────────────────────────────────────────────────────

const PANEL_PERSONA: ExpertDefinition = {
  slug: "persona-vp",
  displayName: "Persona VP",
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

describe("panel chat — generic expert unindexed-docs warning (#1103)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(async () => {
    await teardown(env);
  });

  async function seedExpertWithDocs(
    def: ExpertDefinition,
    files: Readonly<Record<string, string>>,
  ): Promise<void> {
    await seedExpert(env, def);
    const docsDir = path.join(env.dataHome, "experts", def.slug, "docs");
    await fs.mkdir(docsDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(docsDir, name), content);
    }
  }

  function runPanel(target: string): { parse: () => Promise<void>; out: () => string } {
    let out = "";
    const cmd = buildChatCommand({
      write: (s) => (out += s),
      writeError: () => undefined,
      engineFactory: () => new MockEngine(),
      inputProvider: () => scriptedInput(["/quit"]),
    });
    return {
      parse: () => cmd.parseAsync(["node", "council-chat", target, "--engine", "mock"]),
      out: () => out,
    };
  }

  it("warns that a generic panel member's docs are unindexed and names the expert + remedy", async () => {
    // PANEL_EXPERT_A is generic and has files in its per-expert docs folder;
    // PANEL_EXPERT_B is generic with no docs (must not warn).
    await seedExpertWithDocs(PANEL_EXPERT_A, {
      "memo.md": "# Memo\n\nThis content is ignored by a generic expert.",
    });
    await seedExpert(env, PANEL_EXPERT_B);
    await writeUserPanel(env, "docwarn-panel", ["panel-a", "panel-b"]);

    const run = runPanel("docwarn-panel");
    await run.parse();
    const out = run.out();

    // Same discriminating warning as the 1:1 chat path: it names the offending
    // expert by slug, states the docs are NOT indexed, and points at --persona.
    expect(out).toMatch(/\(panel-a\) is a generic expert/);
    expect(out).toMatch(/are NOT indexed and will be ignored/);
    expect(out).toMatch(/--persona/);
    // The panel's managed-docs flow is untouched — no persona doc processing.
    expect(out).not.toMatch(/processing persona documents/i);
    // Only the qualifying member warns — panel-b (no docs) must not appear.
    expect(out).not.toMatch(/\(panel-b\) is a generic expert/);
  });

  it("emits the unindexed-docs warning exactly once for a single qualifying member", async () => {
    // Two files in ONE generic member's docs folder => still exactly ONE
    // warning (per-expert, reporting the file count), never one per file.
    await seedExpertWithDocs(PANEL_EXPERT_A, { "a.md": "alpha", "b.md": "beta" });
    await seedExpert(env, PANEL_EXPERT_B);
    await writeUserPanel(env, "once-panel", ["panel-a", "panel-b"]);

    const run = runPanel("once-panel");
    await run.parse();
    const out = run.out();

    const matches = out.match(/is a generic expert/g) ?? [];
    expect(matches.length).toBe(1);
    // The single warning reports the count of ignored files for that expert.
    expect(out).toMatch(/2 document\(s\)/);
  });

  it("warns once per qualifying generic member when several members have docs", async () => {
    await seedExpertWithDocs(PANEL_EXPERT_A, { "a.md": "alpha" });
    await seedExpertWithDocs(PANEL_EXPERT_B, { "b.md": "beta" });
    await writeUserPanel(env, "multi-panel", ["panel-a", "panel-b"]);

    const run = runPanel("multi-panel");
    await run.parse();
    const out = run.out();

    // Exactly one warning per qualifying member, each naming its own expert.
    const matches = out.match(/is a generic expert/g) ?? [];
    expect(matches.length).toBe(2);
    expect(out).toMatch(/\(panel-a\) is a generic expert/);
    expect(out).toMatch(/\(panel-b\) is a generic expert/);
  });

  it("does not warn when a panel's generic members have no docs", async () => {
    await seedExpert(env, PANEL_EXPERT_A);
    await seedExpert(env, PANEL_EXPERT_B);
    await writeUserPanel(env, "nodocs-panel", ["panel-a", "panel-b"]);

    const run = runPanel("nodocs-panel");
    await run.parse();
    const out = run.out();

    expect(out).not.toMatch(/is a generic expert/);
    expect(out).not.toMatch(/not indexed/i);
  });

  it("does not warn for a persona (trained) panel member that has docs", async () => {
    // A persona member's docs ARE indexable by the pipeline — this is NOT the
    // generic-ignored case, so the generic-unindexed warning must not fire.
    await seedExpertWithDocs(PANEL_PERSONA, { "memo.md": "# Memo\n\nPersona content." });
    await seedExpert(env, PANEL_EXPERT_B);
    await writeUserPanel(env, "persona-panel", ["persona-vp", "panel-b"]);

    const run = runPanel("persona-panel");
    await run.parse();
    const out = run.out();

    expect(out).not.toMatch(/is a generic expert/);
    expect(out).not.toMatch(/not indexed/i);
  });

  it("sanitizes an adversarial generic member displayName in the unindexed-docs warning", async () => {
    // The displayName is model/user-derived. It must be collapsed to a single
    // control-free terminal line by the same renderer sink the 1:1 path uses.
    // Bytes: BEL, bare ESC, C1 CSI, DEL, RTL-override (bidi), U+2028 line
    // separator, CR and LF — all stripped/collapsed to spaces => "ALPHA BETA
    // GAMMA".
    const adversarial: ExpertDefinition = {
      ...PANEL_EXPERT_A,
      slug: "adv-generic",
      displayName: "ALPHA\u0007\u001B\u009B\u007F\u202E\u2028\rBETA\nGAMMA",
    };
    await seedExpertWithDocs(adversarial, { "memo.md": "ignored" });
    await writeUserPanel(env, "adv-panel", ["adv-generic"]);

    const run = runPanel("adv-panel");
    await run.parse();
    const out = run.out();

    // Rendered as one line with all control bytes stripped/collapsed.
    expect(out).toContain('Expert "ALPHA BETA GAMMA"');
    expect(out).toMatch(/\(adv-generic\) is a generic expert/);
    // No terminal-hostile bytes leak. (ESC is intentionally excluded: chalk
    // legitimately emits SGR color codes around the "warn" symbol under
    // FORCE_COLOR, so an ESC in the buffer is not from the display name.)
    for (const ch of ["\u0007", "\u009B", "\u007F", "\u202E", "\u2028"]) {
      expect(out).not.toContain(ch);
    }
  });
});
