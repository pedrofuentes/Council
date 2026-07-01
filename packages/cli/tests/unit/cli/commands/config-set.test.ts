/**
 * Tests for `council config set`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliUserError } from "../../../../src/cli/cli-user-error.js";
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
): Promise<{ stdout: string; stderr: string; error: unknown }> {
  let stdout = "";
  let stderr = "";
  let error: unknown;
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
  await cmd.parseAsync(["node", "council-config", ...args]).catch((err: unknown) => {
    error = err;
  });
  return { stdout, stderr, error };
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

  it.each(["false", "off", "no", "0"])(
    "sets telemetry.enabled to false from %s",
    async (rawValue) => {
      await runConfig(["set", "telemetry.enabled", "true"]);

      const { stdout, stderr, error } = await runConfig(["set", "telemetry.enabled", rawValue]);

      expect(error).toBeUndefined();
      expect(stderr).toBe("");
      expect(stdout).toContain("Set telemetry.enabled = false");
      const config = await loadConfig();
      expect(config.telemetry.enabled).toBe(false);
    },
  );

  it("rejects invalid telemetry.enabled values as a user error", async () => {
    const { stdout, stderr, error } = await runConfig(["set", "telemetry.enabled", "maybe"]);

    expect(stdout).toBe("");
    expect(error).toBeInstanceOf(CliUserError);
    expect((error as CliUserError).message).toContain("must be true or false");
    expect(stderr).toContain("Config value for telemetry.enabled must be true or false.");
  });

  it("sets defaults.engine to a valid engine", async () => {
    const { stdout, stderr, error } = await runConfig(["set", "defaults.engine", "mock"]);

    expect(error).toBeUndefined();
    expect(stderr).toBe("");
    expect(stdout).toContain("Set defaults.engine = mock");
    const config = await loadConfig();
    expect(config.defaults.engine).toBe("mock");
  });

  it("rejects invalid defaults.engine values as a user error", async () => {
    const { stdout, stderr, error } = await runConfig(["set", "defaults.engine", "ollama"]);

    expect(stdout).toBe("");
    expect(error).toBeInstanceOf(CliUserError);
    expect((error as CliUserError).message).toContain("must be one of");
    expect(stderr).toContain(
      "Config value for defaults.engine must be one of: copilot, mock, openai, anthropic",
    );
  });

  describe("chat.* settings", () => {
    it.each([
      ["chat.recentTurnCount", "25", 25],
      ["chat.summaryMaxWords", "750", 750],
      ["chat.longConversationWarning", "1500", 1500],
    ] as const)("sets %s to a valid integer", async (key, rawValue, expectedValue) => {
      const { stdout, stderr, error } = await runConfig(["set", key, rawValue]);

      expect(error).toBeUndefined();
      expect(stderr).toBe("");
      expect(stdout).toContain(`Set ${key} = ${rawValue}`);
      const config = await loadConfig();
      if (key === "chat.recentTurnCount") {
        expect(config.chat.recentTurnCount).toBe(expectedValue);
      } else if (key === "chat.summaryMaxWords") {
        expect(config.chat.summaryMaxWords).toBe(expectedValue);
      } else {
        expect(config.chat.longConversationWarning).toBe(expectedValue);
      }
    });

    it.each([
      ["chat.recentTurnCount", "4", ">=5"],
      ["chat.summaryMaxWords", "99", ">=100"],
      ["chat.longConversationWarning", "49", ">=50"],
    ] as const)("rejects out-of-range %s values as user errors", async (key, rawValue, bound) => {
      const { stdout, stderr, error } = await runConfig(["set", key, rawValue]);

      expect(stdout).toBe("");
      expect(error).toBeInstanceOf(CliUserError);
      expect((error as CliUserError).message).toContain("Invalid Council config");
      expect(stderr).toContain("Invalid Council config");
      expect(stderr).toContain(key);
      expect(stderr).toContain(bound);
    });

    it("rejects non-integer chat values as a user error", async () => {
      const { stdout, stderr, error } = await runConfig(["set", "chat.recentTurnCount", "10.5"]);

      expect(stdout).toBe("");
      expect(error).toBeInstanceOf(CliUserError);
      expect((error as CliUserError).message).toContain("must be an integer");
      expect(stderr).toContain("Config value for chat.recentTurnCount must be an integer.");
    });
  });

  describe("strict integer coercion", () => {
    // `defaults.maxRounds` is the representative integer key for #1509. Every
    // integer-valued key must reject input that `Number()` silently coerces —
    // empty/whitespace (→0), hex (`0x2`), exponent (`1e0`), and fractional
    // (`1.5`) forms — at the input boundary, before it can reach config.yaml.
    it.each(["", "   ", "0x2", "1e0", "1.5"])(
      "rejects %j for defaults.maxRounds as a user error",
      async (rawValue) => {
        const { stdout, stderr, error } = await runConfig(["set", "defaults.maxRounds", rawValue]);

        expect(stdout).toBe("");
        expect(error).toBeInstanceOf(CliUserError);
        expect((error as CliUserError).message).toContain("must be an integer");
        expect(stderr).toContain("Config value for defaults.maxRounds must be an integer.");
      },
    );

    it("accepts a plain decimal integer for defaults.maxRounds", async () => {
      const { stdout, stderr, error } = await runConfig(["set", "defaults.maxRounds", "7"]);

      expect(error).toBeUndefined();
      expect(stderr).toBe("");
      expect(stdout).toContain("Set defaults.maxRounds = 7");
      const config = await loadConfig();
      expect(config.defaults.maxRounds).toBe(7);
    });
  });

  it("rejects unsupported keys with the valid key list", async () => {
    const { stdout, stderr, error } = await runConfig(["set", "providers.openai.apiKeyEnvVar", "OPENAI_API_KEY"]);

    expect(stdout).toBe("");
    expect(error).toBeInstanceOf(CliUserError);
    expect((error as CliUserError).message).toContain("Unsupported config key");
    expect(stderr).toContain("Unsupported config key");
    expect(stderr).toContain("defaults.model");
    expect(stderr).toContain("defaults.maxWordsPerResponse");
    expect(stderr).toContain("telemetry.enabled");
  });

  it("prints validation errors and does not rewrite the config file", async () => {
    const configPath = path.join(testHome, "config.yaml");
    await fs.mkdir(testHome, { recursive: true });
    await fs.writeFile(configPath, "defaults:\n  maxExperts: 3\n", "utf-8");

    const { stdout, stderr, error } = await runConfig(["set", "defaults.maxExperts", "1"]);

    expect(stdout).toBe("");
    expect(error).toBeInstanceOf(CliUserError);
    expect((error as CliUserError).message).toContain("Invalid Council config");
    expect(stderr).toContain("Invalid Council config");
    expect(stderr).toContain("defaults.maxExperts");
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe("defaults:\n  maxExperts: 3\n");
  });
});
