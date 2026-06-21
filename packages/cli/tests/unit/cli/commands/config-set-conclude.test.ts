/**
 * Tests for `council config set conclude.*` keys.
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

describe("buildConfigCommand config set conclude.*", () => {
  let testHome: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(process.cwd(), ".tmp-config-set-conclude-"));
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

  describe("conclude.maxTranscriptChars", () => {
    it("sets conclude.maxTranscriptChars to a positive number", async () => {
      const { stdout, stderr } = await runConfig(["set", "conclude.maxTranscriptChars", "80000"]);

      expect(stderr).toBe("");
      expect(stdout).toContain("Set conclude.maxTranscriptChars = 80000");
      const config = await loadConfig();
      expect(config.conclude.maxTranscriptChars).toBe(80000);
    });

    it("sets conclude.maxTranscriptChars to minimum (1000)", async () => {
      const { stdout, stderr } = await runConfig(["set", "conclude.maxTranscriptChars", "1000"]);

      expect(stderr).toBe("");
      expect(stdout).toContain("Set conclude.maxTranscriptChars = 1000");
      const config = await loadConfig();
      expect(config.conclude.maxTranscriptChars).toBe(1000);
    });

    it("sets conclude.maxTranscriptChars to maximum (1000000)", async () => {
      const { stdout, stderr } = await runConfig(["set", "conclude.maxTranscriptChars", "1000000"]);

      expect(stderr).toBe("");
      expect(stdout).toContain("Set conclude.maxTranscriptChars = 1000000");
      const config = await loadConfig();
      expect(config.conclude.maxTranscriptChars).toBe(1000000);
    });

    it("rejects non-numeric value", async () => {
      const { stderr } = await runConfig(["set", "conclude.maxTranscriptChars", "huge"]);

      expect(stderr).toContain("conclude.maxTranscriptChars");
      expect(stderr).toMatch(/number/i);
    });

    it("rejects value below minimum (1000)", async () => {
      const { stderr } = await runConfig(["set", "conclude.maxTranscriptChars", "999"]);

      expect(stderr).toContain("conclude.maxTranscriptChars");
      expect(stderr).toMatch(/1000 and 1000000/);
    });

    it("rejects value above maximum (1000000)", async () => {
      const { stderr } = await runConfig(["set", "conclude.maxTranscriptChars", "1000001"]);

      expect(stderr).toContain("conclude.maxTranscriptChars");
      expect(stderr).toMatch(/1000 and 1000000/);
    });
  });

  describe("valid keys listing", () => {
    it("includes conclude.maxTranscriptChars in unsupported key error", async () => {
      const { stderr } = await runConfig([
        "set",
        "providers.openai.apiKeyEnvVar",
        "OPENAI_API_KEY",
      ]);

      expect(stderr).toContain("Unsupported config key");
      expect(stderr).toContain("conclude.maxTranscriptChars");
    });
  });
});
