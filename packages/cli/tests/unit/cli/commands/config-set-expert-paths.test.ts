/**
 * Tests for `council config set expert.* and paths.*` keys.
 *
 * These keys are documented as settable in the config reference but were
 * previously rejected by `council config set`. The `paths.dataHome` key
 * echoes a user-supplied path back to the terminal, so its output must be
 * sanitized against terminal-injection.
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

describe("buildConfigCommand config set expert.* and paths.*", () => {
  let testHome: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(process.cwd(), ".tmp-config-set-expert-paths-"));
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

  describe("expert.recencyHalfLifeDays", () => {
    it("sets a valid integer", async () => {
      const { stdout, stderr, error } = await runConfig([
        "set",
        "expert.recencyHalfLifeDays",
        "30",
      ]);

      expect(error).toBeUndefined();
      expect(stderr).toBe("");
      expect(stdout).toContain("Set expert.recencyHalfLifeDays = 30");
      const config = await loadConfig();
      expect(config.expert.recencyHalfLifeDays).toBe(30);
    });

    it.each([["1"], ["365"]] as const)("accepts boundary value %s", async (rawValue) => {
      const { stderr, error } = await runConfig(["set", "expert.recencyHalfLifeDays", rawValue]);

      expect(error).toBeUndefined();
      expect(stderr).toBe("");
      const config = await loadConfig();
      expect(config.expert.recencyHalfLifeDays).toBe(Number(rawValue));
    });

    it("rejects a non-integer value as a user error", async () => {
      const { stderr, error } = await runConfig(["set", "expert.recencyHalfLifeDays", "90.5"]);

      expect(error).toBeInstanceOf(CliUserError);
      expect(stderr).toContain("Config value for expert.recencyHalfLifeDays must be an integer.");
    });

    it("rejects a value below the minimum (1) as a user error", async () => {
      const { stderr, error } = await runConfig(["set", "expert.recencyHalfLifeDays", "0"]);

      expect(error).toBeInstanceOf(CliUserError);
      expect(stderr).toContain("expert.recencyHalfLifeDays");
      expect(stderr).toContain(">=1");
    });

    it("rejects a value above the maximum (365) as a user error", async () => {
      const { stderr, error } = await runConfig(["set", "expert.recencyHalfLifeDays", "400"]);

      expect(error).toBeInstanceOf(CliUserError);
      expect(stderr).toContain("expert.recencyHalfLifeDays");
      expect(stderr).toContain("<=365");
    });
  });

  describe("expert.supportedFormats", () => {
    it("normalizes a comma-separated list, lowercasing and adding leading dots", async () => {
      const { stdout, stderr, error } = await runConfig([
        "set",
        "expert.supportedFormats",
        ".MD, txt , .Pdf",
      ]);

      expect(error).toBeUndefined();
      expect(stderr).toBe("");
      expect(stdout).toContain("Set expert.supportedFormats = .md, .txt, .pdf");
      const config = await loadConfig();
      expect(config.expert.supportedFormats).toEqual([".md", ".txt", ".pdf"]);
    });

    it("deduplicates and drops empty segments", async () => {
      const { stderr, error } = await runConfig([
        "set",
        "expert.supportedFormats",
        ".md,,.md, .txt,",
      ]);

      expect(error).toBeUndefined();
      expect(stderr).toBe("");
      const config = await loadConfig();
      expect(config.expert.supportedFormats).toEqual([".md", ".txt"]);
    });
  });

  describe("paths.dataHome", () => {
    it("sets a non-empty path and warns that existing data is not moved", async () => {
      const { stdout, stderr, error } = await runConfig([
        "set",
        "paths.dataHome",
        "/custom/council-data",
      ]);

      expect(error).toBeUndefined();
      expect(stderr).toBe("");
      expect(stdout).toContain("Set paths.dataHome = /custom/council-data");
      expect(stdout.toLowerCase()).toContain("not moved");
      expect(stdout).toContain("/custom/council-data");
      const config = await loadConfig();
      expect(config.paths.dataHome).toBe("/custom/council-data");
    });

    it("rejects an empty value as a user error", async () => {
      const { stderr, error } = await runConfig(["set", "paths.dataHome", ""]);

      expect(error).toBeInstanceOf(CliUserError);
      expect(stderr).not.toContain("Unsupported config key");
      expect(stderr).toContain("paths.dataHome");
      expect(stderr).toMatch(/non-empty/i);
    });

    it("rejects a whitespace-only value as a user error", async () => {
      const { stderr, error } = await runConfig(["set", "paths.dataHome", "   "]);

      expect(error).toBeInstanceOf(CliUserError);
      expect(stderr).not.toContain("Unsupported config key");
      expect(stderr).toContain("paths.dataHome");
      expect(stderr).toMatch(/non-empty/i);
    });

    it("sanitizes control characters in the data-not-moved hint", async () => {
      const maliciousPath = "/data\u001b[31m/evil";
      const { stdout, error } = await runConfig(["set", "paths.dataHome", maliciousPath]);

      expect(error).toBeUndefined();
      // The ANSI escape introducer must never reach the terminal.
      expect(stdout).not.toContain("\u001b");
      // The sanitized path text is still shown so the hint stays useful.
      expect(stdout).toContain("/data/evil");
    });
  });

  describe("valid keys listing", () => {
    it("includes the new expert.* and paths.* keys in the unsupported-key error", async () => {
      const { stderr } = await runConfig([
        "set",
        "providers.openai.apiKeyEnvVar",
        "OPENAI_API_KEY",
      ]);

      expect(stderr).toContain("Unsupported config key");
      expect(stderr).toContain("expert.recencyHalfLifeDays");
      expect(stderr).toContain("expert.supportedFormats");
      expect(stderr).toContain("paths.dataHome");
    });
  });
});
