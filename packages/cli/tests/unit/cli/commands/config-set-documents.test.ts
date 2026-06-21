/**
 * Tests for `council config set documents.*` keys.
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

describe("buildConfigCommand config set documents.*", () => {
  let testHome: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(process.cwd(), ".tmp-config-set-docs-"));
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

  describe("documents.aiExtraction", () => {
    it("sets documents.aiExtraction to 'ask'", async () => {
      const { stdout, stderr } = await runConfig(["set", "documents.aiExtraction", "ask"]);

      expect(stderr).toBe("");
      expect(stdout).toContain("Set documents.aiExtraction = ask");
      const config = await loadConfig();
      expect(config.documents.aiExtraction).toBe("ask");
    });

    it("sets documents.aiExtraction to 'off'", async () => {
      const { stdout, stderr } = await runConfig(["set", "documents.aiExtraction", "off"]);

      expect(stderr).toBe("");
      expect(stdout).toContain("Set documents.aiExtraction = off");
      const config = await loadConfig();
      expect(config.documents.aiExtraction).toBe("off");
    });

    it("sets documents.aiExtraction to 'auto'", async () => {
      const { stdout, stderr } = await runConfig(["set", "documents.aiExtraction", "auto"]);

      expect(stderr).toBe("");
      expect(stdout).toContain("Set documents.aiExtraction = auto");
      const config = await loadConfig();
      expect(config.documents.aiExtraction).toBe("auto");
    });

    it("rejects invalid enum value with clear error", async () => {
      const { stderr } = await runConfig(["set", "documents.aiExtraction", "maybe"]);

      expect(stderr).toContain("documents.aiExtraction");
      expect(stderr).toMatch(/off|ask|auto/);
    });
  });

  describe("documents.maxFileSizeMB", () => {
    it("sets documents.maxFileSizeMB to a positive number", async () => {
      const { stdout, stderr } = await runConfig(["set", "documents.maxFileSizeMB", "100"]);

      expect(stderr).toBe("");
      expect(stdout).toContain("Set documents.maxFileSizeMB = 100");
      const config = await loadConfig();
      expect(config.documents.maxFileSizeMB).toBe(100);
    });

    it("sets documents.maxFileSizeMB to minimum (1)", async () => {
      const { stdout, stderr } = await runConfig(["set", "documents.maxFileSizeMB", "1"]);

      expect(stderr).toBe("");
      expect(stdout).toContain("Set documents.maxFileSizeMB = 1");
      const config = await loadConfig();
      expect(config.documents.maxFileSizeMB).toBe(1);
    });

    it("sets documents.maxFileSizeMB to maximum (500)", async () => {
      const { stdout, stderr } = await runConfig(["set", "documents.maxFileSizeMB", "500"]);

      expect(stderr).toBe("");
      expect(stdout).toContain("Set documents.maxFileSizeMB = 500");
      const config = await loadConfig();
      expect(config.documents.maxFileSizeMB).toBe(500);
    });

    it("rejects non-numeric value", async () => {
      const { stderr } = await runConfig(["set", "documents.maxFileSizeMB", "large"]);

      expect(stderr).toContain("documents.maxFileSizeMB");
      expect(stderr).toMatch(/number/i);
    });

    it("rejects zero", async () => {
      const { stderr } = await runConfig(["set", "documents.maxFileSizeMB", "0"]);

      expect(stderr).toContain("documents.maxFileSizeMB");
    });

    it("rejects negative number", async () => {
      // Commander.js treats '-5' as an option flag, so test with explicit validation
      // by checking that the coercion logic properly validates range
      const { stderr } = await runConfig(["set", "documents.maxFileSizeMB", "0.5"]);

      expect(stderr).toContain("documents.maxFileSizeMB");
      expect(stderr).toMatch(/1 and 500/);
    });

    it("rejects value above maximum (500)", async () => {
      const { stderr } = await runConfig(["set", "documents.maxFileSizeMB", "501"]);

      expect(stderr).toContain("documents.maxFileSizeMB");
    });
  });

  describe("documents.aiExtractionAllowedExtensions", () => {
    it("sets a comma-separated list, normalizing case and leading dots", async () => {
      const { stdout, stderr } = await runConfig([
        "set",
        "documents.aiExtractionAllowedExtensions",
        ".PNG, zip , .Log",
      ]);

      expect(stderr).toBe("");
      expect(stdout).toContain("Set documents.aiExtractionAllowedExtensions");
      const config = await loadConfig();
      expect(config.documents.aiExtractionAllowedExtensions).toEqual([".png", ".zip", ".log"]);
    });

    it("deduplicates and drops empty segments", async () => {
      const { stderr } = await runConfig([
        "set",
        "documents.aiExtractionAllowedExtensions",
        ".epub,,.epub, .mobi,",
      ]);

      expect(stderr).toBe("");
      const config = await loadConfig();
      expect(config.documents.aiExtractionAllowedExtensions).toEqual([".epub", ".mobi"]);
    });

    it("clears the allow-list when set to an empty value", async () => {
      await runConfig(["set", "documents.aiExtractionAllowedExtensions", ".epub"]);
      const { stderr } = await runConfig(["set", "documents.aiExtractionAllowedExtensions", ""]);

      expect(stderr).toBe("");
      const config = await loadConfig();
      expect(config.documents.aiExtractionAllowedExtensions).toEqual([]);
    });

    it("is reflected by config show", async () => {
      await runConfig(["set", "documents.aiExtractionAllowedExtensions", ".png,.zip"]);
      const { stdout } = await runConfig(["show"]);

      expect(stdout).toContain("documents.aiExtractionAllowedExtensions");
      expect(stdout).toContain(".png, .zip");
    });
  });

  describe("valid keys listing", () => {
    it("includes documents.aiExtraction in unsupported key error", async () => {
      const { stderr } = await runConfig([
        "set",
        "providers.openai.apiKeyEnvVar",
        "OPENAI_API_KEY",
      ]);

      expect(stderr).toContain("Unsupported config key");
      expect(stderr).toContain("documents.aiExtraction");
      expect(stderr).toContain("documents.maxFileSizeMB");
    });

    it("includes documents.aiExtractionAllowedExtensions in the settable key list", async () => {
      const { stderr } = await runConfig([
        "set",
        "providers.openai.apiKeyEnvVar",
        "OPENAI_API_KEY",
      ]);

      expect(stderr).toContain("Unsupported config key");
      expect(stderr).toContain("documents.aiExtractionAllowedExtensions");
    });
  });
});
