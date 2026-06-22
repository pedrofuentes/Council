/**
 * Tests for `council config set qualityGate.*` keys.
 *
 * `qualityGate` is the config surface for the anti-sycophancy quality gate:
 *   - `qualityGate.mode` is an enum (off/warn/regenerate) coerced exactly like
 *     `documents.aiExtraction` — invalid values are rejected at the input
 *     boundary with the valid choices listed.
 *   - `qualityGate.maxRegenerations` is an integer bounded 0..3; non-integer
 *     and out-of-range values are rejected before they can reach config.yaml.
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

describe("buildConfigCommand config set qualityGate.*", () => {
  let testHome: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(process.cwd(), ".tmp-config-set-quality-gate-"));
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

  describe("qualityGate.mode", () => {
    it.each(["off", "warn", "regenerate"] as const)("sets mode to '%s'", async (mode) => {
      const { stdout, stderr, error } = await runConfig(["set", "qualityGate.mode", mode]);

      expect(error).toBeUndefined();
      expect(stderr).toBe("");
      expect(stdout).toContain(`Set qualityGate.mode = ${mode}`);
      const config = await loadConfig();
      expect(config.qualityGate.mode).toBe(mode);
    });

    it("rejects an invalid mode as a user error listing valid values", async () => {
      const { stderr, error } = await runConfig(["set", "qualityGate.mode", "loud"]);

      expect(error).toBeInstanceOf(CliUserError);
      expect(stderr).toContain("qualityGate.mode");
      expect(stderr).toMatch(/one of/i);
      expect(stderr).toContain("off");
      expect(stderr).toContain("warn");
      expect(stderr).toContain("regenerate");
    });
  });

  describe("qualityGate.maxRegenerations", () => {
    it.each([["0"], ["1"], ["2"], ["3"]] as const)(
      "accepts boundary value %s",
      async (rawValue) => {
        const { stdout, stderr, error } = await runConfig([
          "set",
          "qualityGate.maxRegenerations",
          rawValue,
        ]);

        expect(error).toBeUndefined();
        expect(stderr).toBe("");
        expect(stdout).toContain(`Set qualityGate.maxRegenerations = ${rawValue}`);
        const config = await loadConfig();
        expect(config.qualityGate.maxRegenerations).toBe(Number(rawValue));
      },
    );

    it("rejects a non-integer value as a user error", async () => {
      const { stderr, error } = await runConfig(["set", "qualityGate.maxRegenerations", "1.5"]);

      expect(error).toBeInstanceOf(CliUserError);
      expect(stderr).toContain("qualityGate.maxRegenerations");
      expect(stderr).toMatch(/integer/i);
      expect(stderr).toMatch(/between 0 and 3/);
    });

    it("rejects a value above the maximum (3) as a user error", async () => {
      const { stderr, error } = await runConfig(["set", "qualityGate.maxRegenerations", "4"]);

      expect(error).toBeInstanceOf(CliUserError);
      expect(stderr).toContain("qualityGate.maxRegenerations");
      expect(stderr).toMatch(/between 0 and 3/);
    });
  });

  describe("valid keys listing", () => {
    it("includes the new qualityGate.* keys in the unsupported-key error", async () => {
      const { stderr } = await runConfig([
        "set",
        "providers.openai.apiKeyEnvVar",
        "OPENAI_API_KEY",
      ]);

      expect(stderr).toContain("Unsupported config key");
      expect(stderr).toContain("qualityGate.mode");
      expect(stderr).toContain("qualityGate.maxRegenerations");
    });
  });
});
