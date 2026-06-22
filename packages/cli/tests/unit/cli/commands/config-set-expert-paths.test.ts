/**
 * Tests for `council config set expert.* and paths.*` keys.
 *
 * These keys are documented as settable in the config reference but were
 * previously rejected by `council config set`. Because `paths.dataHome` flows
 * into terminal output — its `set` echo plus every `council config show` run —
 * a value carrying ANSI/OSC/C0/C1/DEL/line-separator bytes is a stored
 * terminal-injection vector. Two defenses are exercised here:
 *   1. `config set paths.dataHome` REJECTS such values at the input boundary.
 *   2. `config show` defensively sanitizes a malicious value that was
 *      hand-edited straight into config.yaml (bypassing defense 1).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as yaml from "yaml";

import { CliUserError } from "../../../../src/cli/cli-user-error.js";
import { buildConfigCommand } from "../../../../src/cli/commands/config.js";
import { toSingleLineDisplay } from "../../../../src/cli/strip-control-chars.js";
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

    it("rejects a value containing an ANSI escape sequence as a user error", async () => {
      const maliciousPath = "/data\u001b[31m/evil";
      const { stdout, stderr, error } = await runConfig(["set", "paths.dataHome", maliciousPath]);

      // The malicious set must now be REJECTED, not silently accepted.
      expect(error).toBeInstanceOf(CliUserError);
      expect(stderr).toContain("paths.dataHome");
      // The ANSI escape introducer must never reach the terminal — neither in
      // the error echo nor (the set failed) any confirmation line.
      expect(stderr).not.toContain("\u001b");
      expect(stdout).not.toContain("\u001b");
      // Nothing malicious may be persisted.
      const config = await loadConfig();
      expect(config.paths.dataHome).not.toBe(maliciousPath);
      expect(config.paths.dataHome).not.toContain("\u001b");
    });

    it.each([
      ["a CSI/ANSI sequence", "/data\u001b[31m/evil"],
      ["an OSC sequence", "/data\u001b]0;pwned\u0007/evil"],
      ["a BEL C0 control", "/data\u0007/evil"],
      ["a NUL C0 control", "/data\u0000/evil"],
      ["a C1 control", "/data\u009b2J/evil"],
      ["a DEL byte", "/data\u007f/evil"],
      ["a carriage return", "/data\r/evil"],
      ["a line feed", "/data\n/evil"],
      ["a tab", "/data\t/evil"],
      ["a line separator (U+2028)", "/data\u2028/evil"],
      ["a paragraph separator (U+2029)", "/data\u2029/evil"],
    ] as const)(
      "rejects paths.dataHome containing %s as a user error",
      async (_label, maliciousPath) => {
        const { stderr, error } = await runConfig(["set", "paths.dataHome", maliciousPath]);

        expect(error).toBeInstanceOf(CliUserError);
        const message = (error as Error).message;
        expect(message).toContain("paths.dataHome");
        // The error message must be a single, control-free line: no raw value
        // bytes are echoed back.
        expect(message).toBe(toSingleLineDisplay(message));
        expect(stderr).toContain("paths.dataHome");
        // The rejected value must never be persisted to config.yaml.
        const config = await loadConfig();
        expect(config.paths.dataHome).toBe(toSingleLineDisplay(config.paths.dataHome));
        expect(config.paths.dataHome).not.toBe(maliciousPath);
      },
    );
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

describe("buildConfigCommand config show terminal-injection defense", () => {
  let testHome: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];
  const originalCouncilDataHome = process.env["COUNCIL_DATA_HOME"];

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(process.cwd(), ".tmp-config-show-sanitize-"));
    process.env["COUNCIL_HOME"] = testHome;
    // `getCouncilDataHome` consults COUNCIL_DATA_HOME before config.paths.dataHome;
    // unset it so the hand-edited config value is what gets rendered.
    delete process.env["COUNCIL_DATA_HOME"];
  });

  afterEach(async () => {
    if (originalCouncilHome === undefined) {
      delete process.env["COUNCIL_HOME"];
    } else {
      process.env["COUNCIL_HOME"] = originalCouncilHome;
    }
    if (originalCouncilDataHome === undefined) {
      delete process.env["COUNCIL_DATA_HOME"];
    } else {
      process.env["COUNCIL_DATA_HOME"] = originalCouncilDataHome;
    }
    await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("strips control characters from a hand-edited paths.dataHome on `config show`", async () => {
    // Simulate a legacy / hand-edited config.yaml that bypassed `config set`
    // input validation entirely.
    const maliciousDataHome =
      "/data\u001b[31m\u001b]0;pwned\u0007\u009b2J\u0000\u007f/evil\r\nFAKE: ok\u2028\u2029\tend";
    const configYaml = yaml.stringify({ paths: { dataHome: maliciousDataHome } });
    await fs.writeFile(path.join(testHome, "config.yaml"), configYaml, "utf-8");

    const { stdout, error } = await runConfig(["show"]);

    expect(error).toBeUndefined();
    // None of the injected control bytes may survive into the rendered output.
    // `Data home`, `Experts directory` and `Panels directory` all derive from
    // dataHome, so this covers every path-derived render in `config show`.
    for (const forbidden of [
      "\u001b",
      "\u0007",
      "\u0000",
      "\u009b",
      "\u007f",
      "\r",
      "\t",
      "\u2028",
      "\u2029",
    ]) {
      expect(stdout).not.toContain(forbidden);
    }
    // The (neutralized) path text is still shown so the diagnostic stays useful.
    expect(stdout).toContain("Data home:");
    expect(stdout).toContain("Experts directory:");
    expect(stdout).toContain("Panels directory:");
    expect(stdout).toContain("evil");
  });
});
