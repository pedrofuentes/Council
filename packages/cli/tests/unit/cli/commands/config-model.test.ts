/**
 * Tests for `council config model` — the dedicated default-model subcommand.
 *
 * The subcommand has three modes:
 *   - `config model <name>`        — validate against the canonical supported
 *     model registry and persist to `defaults.model` (same path as
 *     `config set defaults.model`); reject unknown ids with an actionable error.
 *   - `config model` on a TTY      — launch the same interactive numbered picker
 *     the wizard uses and persist the selection.
 *   - `config model` with no TTY   — never hang: print the current model and the
 *     available models, then exit non-zero with guidance to pass `<name>`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliUserError } from "../../../../src/cli/cli-user-error.js";
import { buildConfigCommand } from "../../../../src/cli/commands/config.js";
import { loadConfig, updateConfigField } from "../../../../src/config/index.js";
import type { Writer } from "../../../../src/cli/commands/writer.js";

interface ConfigCommandDeps {
  readonly write?: Writer;
  readonly writeError?: Writer;
  readonly modelDeps?: {
    readonly input?: NodeJS.ReadableStream;
    readonly output?: NodeJS.WritableStream;
    readonly discoverModels?: () => Promise<{
      readonly models: readonly string[];
      readonly source: "live" | "static";
    }>;
  };
}

function createTtyInput(text: string): NodeJS.ReadableStream {
  const input = new PassThrough();
  Object.defineProperty(input, "isTTY", { value: true, configurable: true });
  input.end(text);
  return input;
}

function createNonTtyInput(): NodeJS.ReadableStream {
  const input = new PassThrough();
  Object.defineProperty(input, "isTTY", { value: false, configurable: true });
  input.end("");
  return input;
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
    undefined,
    deps.modelDeps,
  );
  cmd.exitOverride();
  await cmd.parseAsync(["node", "council-config", ...args]).catch((err: unknown) => {
    error = err;
  });
  return { stdout, stderr, error };
}

describe("buildConfigCommand config model", () => {
  let testHome: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(process.cwd(), ".tmp-config-model-"));
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

  describe("with a model argument", () => {
    it("persists a supported model to defaults.model", async () => {
      const { stdout, stderr, error } = await runConfig(["model", "claude-sonnet-4.6"]);

      expect(error).toBeUndefined();
      expect(stderr).toBe("");
      expect(stdout).toContain("Set defaults.model = claude-sonnet-4.6");
      const config = await loadConfig();
      expect(config.defaults.model).toBe("claude-sonnet-4.6");
    });

    it("accepts the `auto` routable selector", async () => {
      const { error } = await runConfig(["model", "auto"]);

      expect(error).toBeUndefined();
      const config = await loadConfig();
      expect(config.defaults.model).toBe("auto");
    });

    it("rejects an unsupported model with an actionable error listing valid models", async () => {
      await updateConfigField("defaults.model", "claude-sonnet-4.5");

      const { stderr, error } = await runConfig(["model", "not-a-real-model"]);

      expect(error).toBeInstanceOf(CliUserError);
      expect(stderr).toMatch(/not-a-real-model/);
      expect(stderr).toContain("claude-sonnet-4.5");
      expect(stderr).toContain("gpt-5.4");
      // Invalid input must never mutate persisted config.
      const config = await loadConfig();
      expect(config.defaults.model).toBe("claude-sonnet-4.5");
    });
  });

  describe("with no argument on a TTY", () => {
    it("launches the interactive picker and persists the selected model", async () => {
      const discoverModels = vi.fn(async () => ({
        models: ["claude-sonnet-4.5", "gpt-5.4"],
        source: "live" as const,
      }));
      const output = new PassThrough();
      output.resume();

      const { stderr, error } = await runConfig(["model"], {
        modelDeps: {
          input: createTtyInput("2\n"),
          output,
          discoverModels,
        },
      });

      expect(error).toBeUndefined();
      expect(stderr).toBe("");
      expect(discoverModels).toHaveBeenCalledTimes(1);
      const config = await loadConfig();
      expect(config.defaults.model).toBe("gpt-5.4");
    });
  });

  describe("with no argument and no TTY", () => {
    it("does not hang: prints the current and available models, then exits non-zero with guidance", async () => {
      await updateConfigField("defaults.model", "claude-sonnet-4.5");
      const discoverModels = vi.fn(async () => ({
        models: ["claude-sonnet-4.5", "gpt-5.4"],
        source: "live" as const,
      }));

      const { stdout, stderr, error } = await runConfig(["model"], {
        modelDeps: {
          input: createNonTtyInput(),
          discoverModels,
        },
      });

      expect(error).toBeInstanceOf(CliUserError);
      expect(stdout).toContain("claude-sonnet-4.5");
      expect(stdout).toContain("gpt-5.4");
      // Guidance to pass an explicit name in automation.
      expect(stderr).toMatch(/config model <name>/);
    });
  });

  // Sentinel PR #1856 follow-ups: config model error/echo hygiene (#1863) and
  // model-branch coverage (#1864).
  describe("non-interactive load + fallback handling", () => {
    it("normalizes a corrupt-config load failure into a clean CliUserError (#1863)", async () => {
      // Corrupt config so loadConfig() throws before model discovery runs.
      await fs.writeFile(path.join(testHome, "config.yaml"), "defaults: {model: [oops\n", "utf-8");
      const discoverModels = vi.fn(async () => ({
        models: ["claude-sonnet-4.5"],
        source: "live" as const,
      }));

      const { stderr, error } = await runConfig(["model"], {
        modelDeps: { input: createNonTtyInput(), discoverModels },
      });

      expect(error).toBeInstanceOf(CliUserError);
      expect(stderr).toContain("Failed to parse Council config");
      // Discovery must not run when the config itself cannot be loaded.
      expect(discoverModels).not.toHaveBeenCalled();
    });

    it("warns when the model list comes from the static fallback (#1864)", async () => {
      await updateConfigField("defaults.model", "claude-sonnet-4.5");
      const discoverModels = vi.fn(async () => ({
        models: ["claude-sonnet-4.5", "gpt-5.4"],
        source: "static" as const,
      }));

      const { stdout, error } = await runConfig(["model"], {
        modelDeps: { input: createNonTtyInput(), discoverModels },
      });

      expect(error).toBeInstanceOf(CliUserError);
      expect(stdout).toContain(
        "Warning: Live model discovery failed, so Council is showing a built-in fallback list.",
      );
    });

    it("sanitizes control characters from an explicit-name write error (#1863)", async () => {
      // A YAML syntax error drags the offending bytes into updateConfigField's
      // message; setModelByName must sanitize before echoing to the terminal.
      const raw =
        "defaults: {model: \tA\u001B[31m\u009B\u009D\u0085\u007F\u202Ex\u2066\u2028\u2029\rEVIL\n";
      await fs.writeFile(path.join(testHome, "config.yaml"), raw, "utf-8");

      const { stderr, error } = await runConfig(["model", "auto"]);

      expect(error).toBeInstanceOf(CliUserError);
      expect(stderr).toContain("Failed to parse Council config");
      const line = stderr.replace(/\n$/, "");
      expect(line).not.toContain("\n");
      expect(line).not.toMatch(
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/,
      );
    });
  });

  describe("interactive picker write boundary", () => {
    const ADVERSARIAL = "gpt\t\u001B[31m\u009B\u009D\u0085\u007F\u202Ea\u2066b\u2028\u2029\rX";

    it("prints the confirmation only after the write succeeds (#1863)", async () => {
      const discoverModels = vi.fn(async () => ({
        models: ["claude-sonnet-4.5", "gpt-5.4"],
        source: "live" as const,
      }));
      const output = new PassThrough();
      output.resume();

      const { stdout, error } = await runConfig(["model"], {
        modelDeps: { input: createTtyInput("2\n"), output, discoverModels },
      });

      expect(error).toBeUndefined();
      expect(stdout).toContain("Set defaults.model = gpt-5.4");
      const config = await loadConfig();
      expect(config.defaults.model).toBe("gpt-5.4");
    });

    it("does not print the confirmation when the picker's write fails (#1863)", async () => {
      // A schema-invalid on-disk config makes updateConfigField reject the write.
      await fs.writeFile(
        path.join(testHome, "config.yaml"),
        "defaults:\n  maxRounds: 999\n",
        "utf-8",
      );
      const discoverModels = vi.fn(async () => ({
        models: ["claude-sonnet-4.5", "gpt-5.4"],
        source: "live" as const,
      }));
      const output = new PassThrough();
      output.resume();

      const { stdout, stderr, error } = await runConfig(["model"], {
        modelDeps: { input: createTtyInput("1\n"), output, discoverModels },
      });

      expect(error).toBeInstanceOf(CliUserError);
      // The write failed → the user must never have seen a success confirmation.
      expect(stdout).not.toContain("Set defaults.model =");
      expect(stderr).toContain("defaults.maxRounds");
    });

    it("refuses to persist a discovered id carrying terminal-control bytes (#1863)", async () => {
      await updateConfigField("defaults.model", "claude-sonnet-4.5");
      // Sole discovered id so the numbered pick lands on the adversarial value
      // regardless of preference ordering.
      const discoverModels = vi.fn(async () => ({
        models: [ADVERSARIAL],
        source: "live" as const,
      }));
      const output = new PassThrough();
      output.resume();

      const { stderr, error } = await runConfig(["model"], {
        modelDeps: { input: createTtyInput("1\n"), output, discoverModels },
      });

      expect(error).toBeInstanceOf(CliUserError);
      // The malicious id must never reach persisted config.
      const config = await loadConfig();
      expect(config.defaults.model).toBe("claude-sonnet-4.5");
      // The rejection echo is a single, control-free line.
      const line = stderr.replace(/\n$/, "");
      expect(line).toContain("control characters");
      expect(line).not.toContain(ADVERSARIAL);
      expect(line).not.toContain("\n");
      expect(line).not.toMatch(
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/,
      );
    });

    it("aborts with a clean error on EOF before a selection is made (#1864)", async () => {
      await updateConfigField("defaults.model", "claude-sonnet-4.5");
      const discoverModels = vi.fn(async () => ({
        models: ["claude-sonnet-4.5", "gpt-5.4"],
        source: "live" as const,
      }));
      const output = new PassThrough();
      output.resume();

      const { stderr, error } = await runConfig(["model"], {
        modelDeps: { input: createTtyInput(""), output, discoverModels },
      });

      expect(error).toBeInstanceOf(CliUserError);
      expect(stderr).toContain("Model selection aborted before completion.");
      // An aborted selection must leave the persisted model untouched.
      const config = await loadConfig();
      expect(config.defaults.model).toBe("claude-sonnet-4.5");
    });
  });
});
