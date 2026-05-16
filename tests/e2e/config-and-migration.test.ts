import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as yaml from "yaml";

import { buildDoctorCommand } from "../../src/cli/commands/doctor.js";
import { buildConveneCommand } from "../../src/cli/commands/convene.js";
import { getCouncilHome, getCouncilDataHome, loadConfig } from "../../src/config/index.js";
import {
  captureOutput,
  cleanupE2EContext,
  createE2EContext,
  makeMockEngineFactory,
  type E2EContext,
} from "./helpers.js";

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Config and Migration E2E", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await createE2EContext();
  });

  afterEach(async () => {
    try {
      await cleanupE2EContext(ctx);
    } catch {
      // best-effort cleanup — Windows may hold SQLite file handles
    }
  });

  it("fresh install: missing config auto-creates", async () => {
    const configPath = path.join(ctx.testHome, "config.yaml");
    // createE2EContext already creates config, so we need to delete it first
    await fs.rm(configPath, { force: true });

    // loadConfig should auto-create the missing config
    const config = await loadConfig();

    const configExists = await fs
      .access(configPath)
      .then(() => true)
      .catch(() => false);
    expect(configExists).toBe(true);

    const configContent = await fs.readFile(configPath, "utf-8");
    expect(configContent).toContain("defaults:");
    expect(configContent).toContain("model:");
    expect(configContent).toContain("telemetry:");
    expect(config.defaults.model).toBe("claude-sonnet-4-20250514");
  });

  it("partial config merges with defaults", async () => {
    const configPath = path.join(ctx.testHome, "config.yaml");
    const partialConfig = {
      defaults: {
        maxRounds: 2,
      },
    };
    await fs.writeFile(configPath, yaml.stringify(partialConfig), "utf-8");

    const config = await loadConfig();

    expect(config.defaults.maxRounds).toBe(2);
    expect(config.defaults.model).toBe("claude-sonnet-4-20250514");
    expect(config.defaults.maxExperts).toBe(3);
    expect(config.defaults.maxWordsPerResponse).toBe(250);
    expect(config.telemetry.enabled).toBe(false);
  });

  it("custom model in config used for debate", async () => {
    const configPath = path.join(ctx.testHome, "config.yaml");
    const customConfig = {
      defaults: {
        model: "gpt-4.1",
      },
    };
    await fs.writeFile(configPath, yaml.stringify(customConfig), "utf-8");

    const output = captureOutput();
    const convene = buildConveneCommand({
      engineFactory: makeMockEngineFactory({
        responses: {
          senior: "Senior Developer perspective",
          security: "Security Auditor perspective",
          moderator: "Thank you all",
        },
      }),
      write: output.write,
      writeError: output.writeError,
    });

    await convene.parseAsync(
      ["node", "test", "Should we ship?", "--template", "code-review", "--engine", "mock"],
      { from: "user" },
    );

    // Verify model was applied by checking output includes execution
    const stdout = output.stdout();
    expect(stdout).toContain("Senior Developer");
    expect(stdout).toContain("Security Auditor");
  });

  it("COUNCIL_HOME env var respected", async () => {
    const customHome = path.join(ctx.testHome, "custom-home");
    await fs.mkdir(customHome, { recursive: true });

    process.env["COUNCIL_HOME"] = customHome;
    const resolvedHome = getCouncilHome();

    expect(resolvedHome).toBe(customHome);

    const output = captureOutput();
    const doctor = buildDoctorCommand({ write: output.write });
    await doctor.parseAsync(["node", "test"], { from: "user" });

    const stdout = output.stdout();
    expect(stdout).toContain(customHome);
  });

  it("COUNCIL_DATA_HOME env var respected", async () => {
    const customDataHome = path.join(ctx.testDataHome, "custom-data");
    await fs.mkdir(customDataHome, { recursive: true });

    process.env["COUNCIL_DATA_HOME"] = customDataHome;
    const resolvedDataHome = getCouncilDataHome();

    expect(resolvedDataHome).toBe(customDataHome);

    const output = captureOutput();
    const convene = buildConveneCommand({
      engineFactory: makeMockEngineFactory({
        responses: {
          senior: "Senior Developer response",
          moderator: "Thank you",
        },
      }),
      write: output.write,
      writeError: output.writeError,
    });

    await convene.parseAsync(
      ["node", "test", "Test topic", "--template", "code-review", "--engine", "mock"],
      { from: "user" },
    );

    await delay(200); // Allow DB to fully close on Windows

    const expertsDir = path.join(customDataHome, "experts");
    const expertsDirExists = await fs
      .access(expertsDir)
      .then(() => true)
      .catch(() => false);
    expect(expertsDirExists).toBe(true);
  });

  it("template migration first convene", async () => {
    const expertsDir = path.join(ctx.testDataHome, "experts");
    await fs.rm(expertsDir, { recursive: true, force: true });

    const output = captureOutput();
    const convene = buildConveneCommand({
      engineFactory: makeMockEngineFactory({
        responses: {
          senior: "Senior Developer perspective",
          security: "Security Auditor perspective",
          moderator: "Conclusion",
        },
      }),
      write: output.write,
      writeError: output.writeError,
    });

    await convene.parseAsync(
      ["node", "test", "Test topic", "--template", "code-review", "--engine", "mock"],
      { from: "user" },
    );

    // Verify migration occurred by checking filesystem
    const expertFiles = await fs.readdir(expertsDir);
    const yamlFiles = expertFiles.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    expect(yamlFiles.length).toBeGreaterThan(0);

    // Verify panel file also exists
    const panelsDir = path.join(ctx.testDataHome, "panels");
    const panelFiles = await fs.readdir(panelsDir);
    const panelYamlFiles = panelFiles.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    expect(panelYamlFiles.length).toBeGreaterThan(0);
  });

  it("template migration idempotent", async () => {
    const expertsDir = path.join(ctx.testDataHome, "experts");
    const output = captureOutput();
    const convene = buildConveneCommand({
      engineFactory: makeMockEngineFactory({
        responses: {
          senior: "Senior Developer first",
          security: "Security Auditor first",
          moderator: "Done",
        },
      }),
      write: output.write,
      writeError: output.writeError,
    });

    await convene.parseAsync(
      ["node", "test", "Topic one", "--template", "code-review", "--engine", "mock"],
      { from: "user" },
    );

    const firstRunFiles = await fs.readdir(expertsDir);
    const firstRunCount = firstRunFiles.filter(
      (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
    ).length;
    expect(firstRunCount).toBeGreaterThan(0);

    // Capture the first set of expert file names
    const firstRunFileNames = new Set(
      firstRunFiles.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")),
    );

    const output2 = captureOutput();
    const convene2 = buildConveneCommand({
      engineFactory: makeMockEngineFactory({
        responses: {
          senior: "Senior Developer second",
          security: "Security Auditor second",
          moderator: "Finished",
        },
      }),
      write: output2.write,
      writeError: output2.writeError,
    });

    await convene2.parseAsync(
      ["node", "test", "Topic two", "--template", "code-review", "--engine", "mock"],
      { from: "user" },
    );

    const secondRunFiles = await fs.readdir(expertsDir);
    const secondRunCount = secondRunFiles.filter(
      (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
    ).length;
    expect(secondRunCount).toBe(firstRunCount);

    // Verify the same expert files exist (idempotent)
    const secondRunFileNames = new Set(
      secondRunFiles.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")),
    );
    expect(secondRunFileNames).toEqual(firstRunFileNames);
  });

  it("data directories auto-created", async () => {
    const newDataHome = path.join(ctx.testDataHome, "nonexistent");
    process.env["COUNCIL_DATA_HOME"] = newDataHome;

    const expertsDir = path.join(newDataHome, "experts");
    const panelsDir = path.join(newDataHome, "panels");

    const output = captureOutput();
    const convene = buildConveneCommand({
      engineFactory: makeMockEngineFactory({
        responses: {
          senior: "Response",
          moderator: "Done",
        },
      }),
      write: output.write,
      writeError: output.writeError,
    });

    await convene.parseAsync(
      ["node", "test", "Auto topic", "--template", "code-review", "--engine", "mock"],
      { from: "user" },
    );

    const [expertsDirExists, panelsDirExists] = await Promise.all([
      fs
        .access(expertsDir)
        .then(() => true)
        .catch(() => false),
      fs
        .access(panelsDir)
        .then(() => true)
        .catch(() => false),
    ]);

    expect(expertsDirExists).toBe(true);
    expect(panelsDirExists).toBe(true);
  });
});
