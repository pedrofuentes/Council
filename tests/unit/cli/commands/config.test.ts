/**
 * Tests for `council config show|path|edit`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildConfigCommand } from "../../../../src/cli/commands/config.js";
import type { Writer } from "../../../../src/cli/commands/writer.js";

export interface ConfigCommandDeps {
  readonly write?: Writer;
  readonly writeError?: Writer;
  readonly editorRunner?: (editor: string, filePath: string) => Promise<void>;
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
    deps.editorRunner,
  );
  cmd.exitOverride();
  await cmd.parseAsync(["node", "council-config", ...args]).catch(() => undefined);
  return { stdout: stdout || "", stderr };
}

describe("buildConfigCommand", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-config-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  describe("config path", () => {
    it("prints the config file path", async () => {
      const { stdout } = await runConfig(["path"]);
      const expected = path.join(testHome, "config.yaml");
      expect(stdout.trim()).toBe(expected);
    });
  });

  describe("config show", () => {
    it("shows effective config values with source annotations", async () => {
      const { stdout } = await runConfig(["show"]);
      expect(stdout).toContain("Config path:");
      expect(stdout).toContain("defaults.model");
      expect(stdout).toContain("defaults.engine");
      expect(stdout).toContain("defaults.maxRounds");
      expect(stdout).toContain("defaults.maxExperts");
      expect(stdout).toContain("defaults.maxWordsPerResponse");
    });

    it("annotates defaults vs config file values", async () => {
      // Write a partial config that sets only model
      const configYaml = "defaults:\n  model: gpt-4o\n";
      await fs.mkdir(testHome, { recursive: true });
      await fs.writeFile(path.join(testHome, "config.yaml"), configYaml, "utf-8");

      const { stdout } = await runConfig(["show"]);
      expect(stdout).toContain("gpt-4o");
      expect(stdout).toContain("(config file)");
      expect(stdout).toContain("(default)");
    });
  });

  describe("config edit", () => {
    it("opens the config file in the editor", async () => {
      const editorRunner = vi.fn(async () => undefined);
      await runConfig(["edit"], { editorRunner });

      expect(editorRunner).toHaveBeenCalledTimes(1);
      const call = editorRunner.mock.calls[0] as [string, string];
      const [_editor, filePath] = call;
      expect(filePath).toBe(path.join(testHome, "config.yaml"));
    });

    it("validates config after editor exits", async () => {
      // Write invalid config before edit
      await fs.mkdir(testHome, { recursive: true });
      const configPath = path.join(testHome, "config.yaml");
      await fs.writeFile(configPath, "defaults:\n  model: gpt-4o\n", "utf-8");

      const editorRunner = vi.fn(async () => {
        // Simulate editor writing invalid config
        await fs.writeFile(configPath, "defaults:\n  maxRounds: 999\n", "utf-8");
      });

      const { stdout, stderr } = await runConfig(["edit"], { editorRunner });
      const combined = stdout + stderr;
      expect(combined).toContain("Validation");
      expect(combined).toContain("restored");

      // Verify original config was restored
      const restored = await fs.readFile(configPath, "utf-8");
      expect(restored).toContain("model: gpt-4o");
    });

    it("shows success message on valid edit", async () => {
      await fs.mkdir(testHome, { recursive: true });
      const configPath = path.join(testHome, "config.yaml");
      await fs.writeFile(configPath, "defaults:\n  model: gpt-4o\n", "utf-8");

      const editorRunner = vi.fn(async () => {
        // Keep config valid
      });

      const { stdout } = await runConfig(["edit"], { editorRunner });
      expect(stdout).toContain("valid");
    });

    it("reports YAML parse errors after edit and restores original", async () => {
      await fs.mkdir(testHome, { recursive: true });
      const configPath = path.join(testHome, "config.yaml");
      await fs.writeFile(configPath, "defaults:\n  model: gpt-4o\n", "utf-8");

      const editorRunner = vi.fn(async () => {
        await fs.writeFile(configPath, "{{broken yaml: [", "utf-8");
      });

      const { stderr } = await runConfig(["edit"], { editorRunner });
      expect(stderr).toContain("Validation failed");
      expect(stderr).toContain("YAML parse error");
      expect(stderr).toContain("restored");

      // Verify original config was restored
      const restored = await fs.readFile(configPath, "utf-8");
      expect(restored).toContain("model: gpt-4o");
    });

    it("uses VISUAL env var for editor resolution", async () => {
      const originalVisual = process.env["VISUAL"];
      process.env["VISUAL"] = "custom-editor";

      const editorRunner = vi.fn(async () => undefined);
      await runConfig(["edit"], { editorRunner });

      const call = editorRunner.mock.calls[0] as [string, string];
      expect(call[0]).toBe("custom-editor");

      if (originalVisual === undefined) delete process.env["VISUAL"];
      else process.env["VISUAL"] = originalVisual;
    });
  });
});
