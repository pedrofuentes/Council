import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ConfigModule from "../../../../src/config/index.js";
import type * as WriterModule from "../../../../src/cli/commands/writer.js";

const testState = {
  councilHome: "",
  councilDataHome: "",
  quiet: false,
};

vi.mock("../../../../src/config/index.js", async () => {
  const actual = await vi.importActual<typeof ConfigModule>("../../../../src/config/index.js");

  return {
    ...actual,
    getCouncilHome: (): string => testState.councilHome,
    getCouncilDataHome: (): string => testState.councilDataHome,
    loadConfig: async () => actual.ConfigSchema.parse({ paths: { dataHome: testState.councilDataHome } }),
  };
});

vi.mock("../../../../src/cli/commands/writer.js", async () => {
  const actual = await vi.importActual<typeof WriterModule>(
    "../../../../src/cli/commands/writer.js",
  );

  return {
    ...actual,
    isQuiet: (): boolean => testState.quiet,
    setQuiet: (enabled: boolean): void => {
      testState.quiet = enabled;
    },
  };
});

import { buildAskCommand } from "../../../../src/cli/commands/ask.js";
import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { setQuiet } from "../../../../src/cli/commands/writer.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { ExpertRepository } from "../../../../src/memory/repositories/experts.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

const CONVENE_DISCOVERY_HINT =
  'Tip: Try `council ask <panel> "<question>"` for follow-ups, or `council sessions` to review past debates.';
const ASK_DISCOVERY_HINT =
  "Tip: Use `council convene --template <panel>` for a full debate, or `council chat <panel>` for conversation.";

function makeMockEngineFactory(): () => CouncilEngine {
  return () => new MockEngine({ responses: {} });
}

async function seedPanel(testHome: string): Promise<string> {
  const db = await createDatabase(path.join(testHome, "council.db"));
  try {
    const panel = await new PanelRepository(db).create({
      name: "ask-test-panel",
      topic: "General",
      copilotHome: path.join(testHome, "copilot"),
      configJson: JSON.stringify({ template: "code-review", mode: "freeform" }),
    });
    await new ExpertRepository(db).create({
      panelId: panel.id,
      slug: "cto",
      displayName: "CTO",
      model: "claude-sonnet-4",
      systemMessage: "[1] IDENTITY\nYou are a CTO.",
    });
    return panel.name;
  } finally {
    await db.destroy();
  }
}

function renderAskHelp(): string {
  const cmd = buildAskCommand({ engineFactory: makeMockEngineFactory() });
  let captured = "";
  cmd.configureOutput({
    writeOut: (chunk: string) => {
      captured += chunk;
    },
    writeErr: (chunk: string) => {
      captured += chunk;
    },
  });
  cmd.outputHelp();
  return captured;
}

describe("post-debate discovery hints", () => {
  let testHome: string;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(process.cwd(), ".post-debate-hints-test-"));
    testState.councilHome = testHome;
    testState.councilDataHome = path.join(testHome, "data");
    await fs.mkdir(testState.councilDataHome, { recursive: true });
    setQuiet(false);
    await copyTemplateDb(path.join(testHome, "council.db"));
  });

  afterEach(async () => {
    setQuiet(false);
    vi.restoreAllMocks();
    testState.councilHome = "";
    testState.councilDataHome = "";
    try {
      await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  });

  it("convene prints a discovery hint after a debate completes", async () => {
    let captured = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: (chunk) => {
        captured += chunk;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we ship the MVP?",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--format",
      "plain",
      "--engine",
      "mock",
    ]);

    expect(captured).toContain(CONVENE_DISCOVERY_HINT);
  });

  it("convene does not print the discovery hint in json format", async () => {
    let captured = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: (chunk) => {
        captured += chunk;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we ship the MVP?",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--format",
      "json",
      "--engine",
      "mock",
    ]);

    expect(captured).not.toContain(CONVENE_DISCOVERY_HINT);
  });

  it("convene does not print the discovery hint in quiet mode", async () => {
    setQuiet(true);

    let captured = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: (chunk) => {
        captured += chunk;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we ship the MVP?",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--format",
      "plain",
      "--engine",
      "mock",
    ]);

    expect(captured).not.toContain(CONVENE_DISCOVERY_HINT);
  });

  it("ask prints a discovery hint after a response completes", async () => {
    const panelName = await seedPanel(testHome);
    let captured = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (chunk) => {
        captured += chunk;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-ask",
      panelName,
      "What should we ship next?",
      "--engine",
      "mock",
      "--format",
      "plain",
    ]);

    expect(captured).toContain(ASK_DISCOVERY_HINT);
  });

  it("ask does not print the discovery hint in json format", async () => {
    const panelName = await seedPanel(testHome);
    let captured = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (chunk) => {
        captured += chunk;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-ask",
      panelName,
      "What should we ship next?",
      "--engine",
      "mock",
      "--format",
      "json",
    ]);

    expect(captured).not.toContain(ASK_DISCOVERY_HINT);
  });

  it("ask does not print the discovery hint in quiet mode", async () => {
    setQuiet(true);

    const panelName = await seedPanel(testHome);
    let captured = "";
    const cmd = buildAskCommand({
      engineFactory: makeMockEngineFactory(),
      write: (chunk) => {
        captured += chunk;
      },
      writeError: () => undefined,
    });

    await cmd.parseAsync([
      "node",
      "council-ask",
      panelName,
      "What should we ship next?",
      "--engine",
      "mock",
      "--format",
      "plain",
    ]);

    expect(captured).not.toContain(ASK_DISCOVERY_HINT);
  });

  it("ask help text includes shell quoting guidance", () => {
    const helpText = renderAskHelp();

    expect(helpText).toMatch(/single quotes/i);
    expect(helpText).toMatch(/\$variables/i);
    expect(helpText).toMatch(/powershell/i);
    expect(helpText).toMatch(/bash/i);
  });

  it("convene prints the discovery hint after an interrupted debate", async () => {
    const writes: string[] = [];
    const subscribeInterrupt = (handler: () => void): (() => void) => {
      handler();
      return () => undefined;
    };
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: (chunk) => {
        writes.push(`OUT:${chunk}`);
      },
      writeError: (chunk) => {
        writes.push(`ERR:${chunk}`);
      },
      subscribeInterrupt,
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "Should we ship the MVP?",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--format",
      "plain",
      "--engine",
      "mock",
    ]);

    const interruptedIndex = writes.findIndex((entry) =>
      entry.includes("Debate interrupted. Partial results saved."),
    );
    const hintIndex = writes.findIndex((entry) => entry.includes(CONVENE_DISCOVERY_HINT));

    expect(interruptedIndex).toBeGreaterThanOrEqual(0);
    expect(hintIndex).toBeGreaterThan(interruptedIndex);
  });
});
