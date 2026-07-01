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

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function hasErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}

describe("buildConfigCommand", () => {
  let testHome: string;
  let dataHome: string;
  let originalHome: string | undefined;
  let originalDataHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-config-test-"));
    dataHome = path.join(testHome, "data");
    originalHome = process.env["COUNCIL_HOME"];
    originalDataHome = process.env["COUNCIL_DATA_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
    process.env["COUNCIL_DATA_HOME"] = dataHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    if (originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
    else process.env["COUNCIL_DATA_HOME"] = originalDataHome;
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

    it("displays Council home directory path", async () => {
      const { stdout } = await runConfig(["show"]);
      expect(stdout).toContain("Council home:");
      expect(stdout).toContain(testHome);
    });

    it("pins the exact data home directory path under COUNCIL_DATA_HOME", async () => {
      const { stdout } = await runConfig(["show"]);
      expect(stdout).toContain(`Data home: ${dataHome}  (experts, panels, documents)`);
    });

    it("pins the exact experts directory path as dataHome/experts", async () => {
      const { stdout } = await runConfig(["show"]);
      expect(stdout).toContain(`Experts directory: ${path.join(dataHome, "experts")}`);
      // Experts live under the data home, never the runtime (council) home.
      expect(stdout).not.toContain(`Experts directory: ${path.join(testHome, "experts")}`);
    });

    it("pins the exact panels directory path as dataHome/panels", async () => {
      const { stdout } = await runConfig(["show"]);
      expect(stdout).toContain(`Panels directory: ${path.join(dataHome, "panels")}`);
      expect(stdout).not.toContain(`Panels directory: ${path.join(testHome, "panels")}`);
    });

    it("displays database file path", async () => {
      const { stdout } = await runConfig(["show"]);
      expect(stdout).toContain("Database:");
      expect(stdout).toContain("council.db");
    });

    // F09: documents.* settings must appear in config show output
    describe("F09: documents.* settings", () => {
      it("shows all documents.* config keys", async () => {
        const { stdout } = await runConfig(["show"]);
        expect(stdout).toContain("documents.aiExtraction");
        expect(stdout).toContain("documents.aiExtractionAllowedExtensions");
        expect(stdout).toContain("documents.maxFileSizeMB");
      });

      it("reflects a non-default documents.maxFileSizeMB value", async () => {
        await fs.mkdir(testHome, { recursive: true });
        await fs.writeFile(
          path.join(testHome, "config.yaml"),
          "documents:\n  maxFileSizeMB: 123\n",
          "utf-8",
        );

        const { stdout } = await runConfig(["show"]);
        expect(stdout).toContain("documents.maxFileSizeMB");
        expect(stdout).toContain("123");
        expect(stdout).toContain("(config file)");
      });

      it("reflects a non-default documents.aiExtraction value", async () => {
        await fs.mkdir(testHome, { recursive: true });
        await fs.writeFile(
          path.join(testHome, "config.yaml"),
          "documents:\n  aiExtraction: ask\n",
          "utf-8",
        );

        const { stdout } = await runConfig(["show"]);
        expect(stdout).toContain("documents.aiExtraction");
        expect(stdout).toContain("ask");
        expect(stdout).toContain("(config file)");
      });
    });

    // F10: home path labels must include clarifying annotations
    describe("F10: clarified home path labels", () => {
      it("Council home label includes annotation for config file and database", async () => {
        const { stdout } = await runConfig(["show"]);
        expect(stdout).toContain("(config file, database)");
      });

      it("Data home label includes annotation for experts, panels, and documents", async () => {
        const { stdout } = await runConfig(["show"]);
        expect(stdout).toContain("(experts, panels, documents)");
      });
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

    it("warns and throws CliUserError when YAML-failure rollback write fails", async () => {
      await fs.mkdir(testHome, { recursive: true });
      const configPath = path.join(testHome, "config.yaml");
      await fs.writeFile(configPath, "defaults:\n  model: gpt-4o\n", "utf-8");

      const editorRunner = vi.fn(async () => {
        await fs.writeFile(configPath, "{{broken yaml: [", "utf-8");
        // Make the rollback writeFile fail (e.g. disk-full / permission change)
        await fs.chmod(configPath, 0o444);
      });

      try {
        const { stderr } = await runConfig(["edit"], { editorRunner });
        expect(stderr).toContain("Validation failed");
        expect(stderr).toContain("could not be restored");
      } finally {
        await fs.chmod(configPath, 0o644);
      }
    });

    it("warns and throws CliUserError when schema-failure rollback write fails", async () => {
      await fs.mkdir(testHome, { recursive: true });
      const configPath = path.join(testHome, "config.yaml");
      await fs.writeFile(configPath, "defaults:\n  model: gpt-4o\n", "utf-8");

      const editorRunner = vi.fn(async () => {
        await fs.writeFile(configPath, "defaults:\n  maxRounds: 999\n", "utf-8");
        await fs.chmod(configPath, 0o444);
      });

      try {
        const { stderr } = await runConfig(["edit"], { editorRunner });
        expect(stderr).toContain("Validation failed");
        expect(stderr).toContain("could not be restored");
      } finally {
        await fs.chmod(configPath, 0o644);
      }
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

    // #742: `config edit` must hold the same write lock as `config set`/`config
    // model` for the whole edit session so the two paths cannot silently
    // clobber each other's writes.
    it("holds the config write lock for the entire edit session and releases it after", async () => {
      await fs.mkdir(testHome, { recursive: true });
      const configPath = path.join(testHome, "config.yaml");
      await fs.writeFile(configPath, "defaults:\n  model: gpt-4o\n", "utf-8");
      const lockPath = `${configPath}.lock`;

      let lockPresentDuringEdit = false;
      let concurrentAcquireRejected = false;
      const editorRunner = vi.fn(async () => {
        lockPresentDuringEdit = await pathExists(lockPath);
        // A concurrent writer using the same exclusive-create lock protocol
        // must be shut out while the edit session is active.
        try {
          const handle = await fs.open(lockPath, "wx");
          await handle.close();
        } catch (err: unknown) {
          concurrentAcquireRejected = hasErrorCode(err, "EEXIST");
        }
      });

      const { stdout } = await runConfig(["edit"], { editorRunner });

      expect(lockPresentDuringEdit).toBe(true);
      expect(concurrentAcquireRejected).toBe(true);
      expect(stdout).toContain("Config saved and valid.");
      // The lock is released once the edit session ends.
      expect(await pathExists(lockPath)).toBe(false);
    });
  });
});
