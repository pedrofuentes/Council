/**
 * Tests for T-10 chat startup messaging polish:
 *   F24 — "no documents" note at panel chat startup when the panel has no docs
 *   F34 — consistent "panel chat" wording everywhere the startup line is emitted
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildChatCommand, type ChatInputProvider } from "../../../../src/cli/commands/chat.js";
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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-t10-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-t10-data-"));
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

const EXPERT_A: ExpertDefinition = {
  slug: "t10-expert-a",
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

const EXPERT_B: ExpertDefinition = {
  slug: "t10-expert-b",
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

async function seedExperts(env: TestEnv): Promise<void> {
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const lib = new FileExpertLibrary(env.dataHome, db);
    await lib.create(EXPERT_A);
    await lib.create(EXPERT_B);
  } finally {
    await db.destroy();
  }
}

async function writePanel(env: TestEnv, name: string, experts: readonly string[]): Promise<void> {
  const dir = path.join(env.dataHome, "panels");
  await fs.mkdir(dir, { recursive: true });
  const lines = [
    `name: ${name}`,
    `description: Test panel for T-10`,
    "experts:",
    ...experts.map((s) => `  - ${s}`),
  ];
  await fs.writeFile(path.join(dir, `${name}.yaml`), lines.join("\n") + "\n", "utf-8");
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

describe("T-10: chat startup messaging", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await makeEnv();
    await seedExperts(env);
    await writePanel(env, "t10-panel", ["t10-expert-a", "t10-expert-b"]);
  });

  afterEach(async () => {
    await teardown(env);
  });

  // ────────────────────────────────────────────────────────────────────
  // F34 — Consistent "panel chat" wording
  // ────────────────────────────────────────────────────────────────────

  describe("F34 — consistent startup wording", () => {
    it('fresh panel chat session emits "Starting panel chat", not "Starting group chat"', async () => {
      let out = "";
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput(["/quit"]),
      });
      await cmd.parseAsync(["node", "council-chat", "t10-panel", "--engine", "mock"]);

      // The startup banner must use the consistent term "panel chat".
      expect(out).toMatch(/Starting panel chat/i);
      // The inconsistent variant must NOT appear.
      expect(out).not.toMatch(/Starting group chat/i);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // F24 — "No documents loaded" note at startup
  // ────────────────────────────────────────────────────────────────────

  describe("F24 — no-documents note at startup", () => {
    it("shows a clear note when the panel has no documents", async () => {
      // No managed docs dir created → scan returns all-zero counts →
      // the note must appear so first-timers know docs are not loaded.
      let out = "";
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput(["/quit"]),
      });
      await cmd.parseAsync(["node", "council-chat", "t10-panel", "--engine", "mock"]);

      expect(out).toMatch(/No documents loaded for this panel/i);
    });

    it("does NOT show the no-docs note when the panel has documents", async () => {
      // Place a real .md file in the managed docs dir. The scanner will
      // detect it as new and set result.indexed >= 1, suppressing the note.
      const docsDir = path.join(env.dataHome, "panels", "t10-panel", "docs");
      await fs.mkdir(docsDir, { recursive: true });
      await fs.writeFile(
        path.join(docsDir, "charter.md"),
        "# Charter\nThis panel reviews architecture decisions.\n",
        "utf-8",
      );

      let out = "";
      const cmd = buildChatCommand({
        write: (s) => (out += s),
        writeError: () => undefined,
        engineFactory: () => new MockEngine(),
        inputProvider: () => scriptedInput(["/quit"]),
      });
      await cmd.parseAsync(["node", "council-chat", "t10-panel", "--engine", "mock"]);

      expect(out).not.toMatch(/No documents loaded for this panel/i);
    });
  });
});
