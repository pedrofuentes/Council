import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliUserError } from "../../../../src/cli/cli-user-error.js";
import { buildConveneCommand } from "../../../../src/cli/commands/convene.js";
import { setQuiet } from "../../../../src/cli/commands/writer.js";
import type { CouncilEngine } from "../../../../src/engine/index.js";
import { MockEngine } from "../../../../src/engine/mock/mock-engine.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { PanelRepository } from "../../../../src/memory/repositories/panels.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

function makeMockEngineFactory(): () => CouncilEngine {
  return () => new MockEngine({ responses: {} });
}

function setStdinIsTTY(value: boolean | undefined): () => void {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  return () => {
    if (original === undefined) {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    } else {
      Object.defineProperty(process.stdin, "isTTY", original);
    }
  };
}

describe("convene interactive topic input", () => {
  let testHome: string;
  let testDataHome: string;
  let originalHome: string | undefined;
  let originalDataHome: string | undefined;
  let restoreStdinIsTTY: (() => void) | undefined;

  beforeEach(async () => {
    const root = path.resolve(".tmp-convene-interactive-topic");
    await fs.mkdir(root, { recursive: true });
    testHome = await fs.mkdtemp(path.join(root, "home-"));
    testDataHome = await fs.mkdtemp(path.join(root, "data-"));
    originalHome = process.env["COUNCIL_HOME"];
    originalDataHome = process.env["COUNCIL_DATA_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    process.env["COUNCIL_DATA_HOME"] = testDataHome;
    await copyTemplateDb(path.join(testHome, "council.db"));
  });

  afterEach(async () => {
    setQuiet(false);
    restoreStdinIsTTY?.();
    restoreStdinIsTTY = undefined;
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    if (originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
    else process.env["COUNCIL_DATA_HOME"] = originalDataHome;
    await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    await fs.rm(testDataHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("calls topicInputProvider when no positional topic is provided and runs with that topic", async () => {
    restoreStdinIsTTY = setStdinIsTTY(true);
    let providerCalls = 0;
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
      topicInputProvider: async () => {
        providerCalls += 1;
        return "Discuss interactive input";
      },
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--format",
      "json",
      "--engine",
      "mock",
    ]);

    expect(providerCalls).toBe(1);
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      expect(panels.some((panel) => panel.topic === "Discuss interactive input")).toBe(true);
    } finally {
      await db.destroy();
    }
  });

  it("keeps the no-topic error in non-TTY mode when no provider is injected", async () => {
    restoreStdinIsTTY = setStdinIsTTY(false);
    let stderr = "";
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: (s) => {
        stderr += s;
      },
    });
    cmd.exitOverride();

    await expect(
      cmd.parseAsync(["node", "council-convene", "--template", "code-review", "--engine", "mock"]),
    ).rejects.toThrow(/no topic provided/i);
    expect(stderr).toMatch(/When running in a terminal/i);
  });

  it("propagates provider aborts as CliUserError", async () => {
    restoreStdinIsTTY = setStdinIsTTY(true);
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
      topicInputProvider: async () => {
        throw new CliUserError("Aborted");
      },
    });

    await expect(
      cmd.parseAsync(["node", "council-convene", "--template", "code-review", "--engine", "mock"]),
    ).rejects.toThrow(/aborted/i);
  });

  it("lets --prompt-file take precedence over topicInputProvider", async () => {
    restoreStdinIsTTY = setStdinIsTTY(true);
    const file = path.join(testHome, "topic.txt");
    await fs.writeFile(file, "Topic from file", "utf-8");
    let providerCalls = 0;
    const cmd = buildConveneCommand({
      engineFactory: makeMockEngineFactory(),
      write: () => undefined,
      writeError: () => undefined,
      topicInputProvider: async () => {
        providerCalls += 1;
        return "Topic from provider";
      },
    });

    await cmd.parseAsync([
      "node",
      "council-convene",
      "--prompt-file",
      file,
      "--template",
      "code-review",
      "--max-rounds",
      "1",
      "--format",
      "json",
      "--engine",
      "mock",
    ]);

    expect(providerCalls).toBe(0);
    const db = await createDatabase(path.join(testHome, "council.db"));
    try {
      const panels = await new PanelRepository(db).findAll();
      expect(panels.some((panel) => panel.topic === "Topic from file")).toBe(true);
      expect(panels.some((panel) => panel.topic === "Topic from provider")).toBe(false);
    } finally {
      await db.destroy();
    }
  });
});
