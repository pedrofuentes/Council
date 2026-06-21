/**
 * Tests for `council config set`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConfigCommand } from "../../../../src/cli/commands/config.js";
import { loadConfig } from "../../../../src/config/index.js";
import type { Writer } from "../../../../src/cli/commands/writer.js";

interface ConfigCommandDeps {
  readonly write?: Writer;
  readonly writeError?: Writer;
}

async function runConfig(
  args: readonly string[],
  deps: ConfigCommandDeps = {},
): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const cmd = buildConfigCommand(
    deps.write ??
      ((s: string) => {
        stdout += s;
      }),
    deps.writeError ??
      ((s: string) => {
        stderr += s;
      }),
  );
  cmd.exitOverride();
  await cmd.parseAsync(["node", "council-config", ...args]).catch(() => undefined);
  return { stdout, stderr };
}

describe("buildConfigCommand config set", () => {
  let testHome: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(process.cwd(), ".tmp-config-set-"));
    process.env["COUNCIL_HOME"] = testHome;
  });

  afterEach(async () => {
    if (originalCouncilHome === undefined) {
      delete process.env["COUNCIL_HOME"];
    } else {
      process.env["COUNCIL_HOME"] = originalCouncilHome;
    }
    await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("sets string config values", async () => {
    const { stdout, stderr } = await runConfig(["set", "defaults.model", "gpt-5"]);

    expect(stderr).toBe("");
    expect(stdout).toContain("Set defaults.model = gpt-5");
    const config = await loadConfig();
    expect(config.defaults.model).toBe("gpt-5");
  });

  it("coerces numeric config values before saving", async () => {
    const { stdout } = await runConfig(["set", "defaults.maxRounds", "7"]);

    expect(stdout).toContain("Set defaults.maxRounds = 7");
    const config = await loadConfig();
    expect(config.defaults.maxRounds).toBe(7);
  });

  it("sets boolean config values", async () => {
    const { stdout } = await runConfig(["set", "telemetry.enabled", "true"]);

    expect(stdout).toContain("Set telemetry.enabled = true");
    const config = await loadConfig();
    expect(config.telemetry.enabled).toBe(true);
  });

  it("rejects unsupported keys with the valid key list", async () => {
    const { stderr } = await runConfig(["set", "providers.openai.apiKeyEnvVar", "OPENAI_API_KEY"]);

    expect(stderr).toContain("Unsupported config key");
    expect(stderr).toContain("defaults.model");
    expect(stderr).toContain("defaults.maxWordsPerResponse");
    expect(stderr).toContain("telemetry.enabled");
  });

  it("prints validation errors and does not rewrite the config file", async () => {
    const configPath = path.join(testHome, "config.yaml");
    await fs.mkdir(testHome, { recursive: true });
    await fs.writeFile(configPath, "defaults:\n  maxExperts: 3\n", "utf-8");

    const { stderr } = await runConfig(["set", "defaults.maxExperts", "1"]);

    expect(stderr).toContain("Invalid Council config");
    expect(stderr).toContain("defaults.maxExperts");
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe("defaults:\n  maxExperts: 3\n");
  });
});
