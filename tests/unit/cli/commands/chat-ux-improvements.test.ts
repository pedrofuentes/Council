/**
 * Tests for T-08 chat UX improvements:
 * 1. Prompt indicator shown to user
 * 2. Help text on startup
 * 3. Exit tokens recognized when command starts with them (e.g., "/exit something")
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildChatCommand,
  isExitCommand,
  getStartupHelpText,
  type ChatInputProvider,
} from "../../../../src/cli/commands/chat.js";
import { FileExpertLibrary } from "../../../../src/core/expert-library.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-chat-ux-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-chat-ux-data-"));
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

describe("Chat UX Improvements (T-08)", () => {
  describe("isExitCommand", () => {
    it("returns true when input is exactly an exit token", () => {
      expect(isExitCommand("exit")).toBe(true);
      expect(isExitCommand("/exit")).toBe(true);
      expect(isExitCommand("quit")).toBe(true);
      expect(isExitCommand("/quit")).toBe(true);
      expect(isExitCommand("EXIT")).toBe(true);
      expect(isExitCommand("/QUIT")).toBe(true);
    });

    it("returns true when input STARTS with an exit token", () => {
      expect(isExitCommand("/exit now")).toBe(true);
      expect(isExitCommand("/quit please")).toBe(true);
      expect(isExitCommand("exit thanks")).toBe(true);
      expect(isExitCommand("quit and save")).toBe(true);
    });

    it("returns true when input STARTS with exit token after trimming whitespace", () => {
      expect(isExitCommand("  /exit")).toBe(true);
      expect(isExitCommand("  /quit now  ")).toBe(true);
    });

    it("returns false when input does not start with an exit token", () => {
      expect(isExitCommand("please exit")).toBe(false);
      expect(isExitCommand("I want to quit")).toBe(false);
      expect(isExitCommand("Thanks. /exit")).toBe(false);
      expect(isExitCommand("")).toBe(false);
      expect(isExitCommand("   ")).toBe(false);
    });
  });

  describe("getStartupHelpText", () => {
    it("returns help text with exit commands", () => {
      const help = getStartupHelpText();
      expect(help).toContain("exit");
      expect(help).toContain("quit");
    });

    it("does NOT advertise unsupported /help command", () => {
      const help = getStartupHelpText();
      expect(help).not.toContain("/help");
    });

    it("returns exact expected help text", () => {
      const help = getStartupHelpText();
      expect(help).toBe("Type /exit or /quit to save and end the conversation.");
    });
  });

  describe("chat UX improvements in sessions", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("shows startup help text when chat begins", async () => {
      await seedExpert(env);
      let out = "";
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput(["/quit"]),
      });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);

      // Should see help text mentioning exit/quit commands
      expect(out.toLowerCase()).toMatch(/exit|quit/);
    });
  });

  describe("exit token recognition in chat loop", () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(async () => {
      await teardown(env);
    });

    it("exits when user types '/exit' followed by text", async () => {
      await seedExpert(env);
      let out = "";
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput(["hello", "/exit thanks for the help"]),
      });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);

      expect(out).toMatch(/Conversation saved/i);
      // The exit command should NOT have been sent to the engine
      expect(out).not.toContain("thanks for the help");
    });

    it("exits when user types 'quit' at the start of a message", async () => {
      await seedExpert(env);
      let out = "";
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput(["test message", "quit now"]),
      });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);

      expect(out).toMatch(/Conversation saved/i);
    });

    it("does NOT exit when exit token appears mid-sentence", async () => {
      await seedExpert(env);
      let out = "";
      const mockEngine = new MockEngine();
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => mockEngine,
        inputProvider: () => scriptedInput(["Thanks. I need to quit soon.", "/quit"]),
      });
      await cmd.parseAsync(["node", "council-chat", "dahlia-cto", "--engine", "mock"]);

      // Message with "quit" mid-sentence should have been processed and expert should respond
      expect(out).toMatch(/\[mock response/);
      // Should still eventually exit cleanly
      expect(out).toMatch(/Conversation saved/i);
    });
  });
});
