/**
 * Tests for `council models`.
 */
import { describe, expect, it, vi } from "vitest";

import {
  buildModelsCommand,
  formatAvailableModels,
  type ModelsDeps,
} from "../../../../src/cli/commands/models.js";

async function runModelsWithResult(
  args: readonly string[],
  deps: ModelsDeps = {},
): Promise<{ readonly stdout: string; readonly stderr: string; readonly error: unknown }> {
  let stdout = "";
  let stderr = "";
  const commandDeps = {
    ...deps,
    write: (chunk: string) => {
      stdout += chunk;
    },
    writeError: (chunk: string) => {
      stderr += chunk;
    },
  } satisfies ModelsDeps;
  const cmd = buildModelsCommand(commandDeps);
  cmd.exitOverride();
  let error: unknown;
  try {
    await cmd.parseAsync(["node", "council-models", ...args]);
  } catch (err: unknown) {
    error = err;
  }
  return { stdout, stderr, error };
}

async function runModels(args: readonly string[], deps: ModelsDeps = {}): Promise<string> {
  const { stdout } = await runModelsWithResult(args, deps);
  return stdout;
}

describe("formatAvailableModels", () => {
  it("formats live models grouped by provider", () => {
    const result = formatAvailableModels(
      ["claude-sonnet-4.6", "gpt-5.4", "gemini-2.5-pro"],
      "live",
    );

    expect(result).toContain("Available models:");
    expect(result).toContain("Anthropic: claude-sonnet-4.6");
    expect(result).toContain("OpenAI   : gpt-5.4");
    expect(result).toContain("Google   : gemini-2.5-pro");
    expect(result).toContain("Note: Available models: Availability depends on your Copilot tier");
  });

  it("formats static fallback models with appropriate label", () => {
    const result = formatAvailableModels(
      ["claude-haiku-4.5", "claude-sonnet-4.5", "gpt-5.4"],
      "static",
    );

    expect(result).toContain("Known models (live discovery unavailable):");
    expect(result).toContain("Anthropic: claude-haiku-4.5, claude-sonnet-4.5");
    expect(result).toContain("OpenAI   : gpt-5.4");
  });

  it("groups real catalog identifiers under their provider label (grouped form)", () => {
    const result = formatAvailableModels(
      ["claude-sonnet-4.5", "gpt-4.1", "gemini-2.5-pro"],
      "live",
    );

    // Assert grouped form — a naive `return models.join(",")` impl fails these
    expect(result).toContain("Anthropic: claude-sonnet-4.5");
    expect(result).toContain("OpenAI   : gpt-4.1");
    expect(result).toContain("Google   : gemini-2.5-pro");
  });

  it("produces header and note with no provider lines when model list is empty", () => {
    const result = formatAvailableModels([], "live");

    expect(result).toContain("Available models:");
    expect(result).toContain("Note: Available models: Availability depends on your Copilot tier");
    expect(result).not.toContain("Anthropic:");
    expect(result).not.toContain("OpenAI   :");
    expect(result).not.toContain("Google   :");
    expect(result).not.toContain("Other    :");
  });

  it("produces header and note with no provider lines when all model IDs are invalid", () => {
    const result = formatAvailableModels(["   ", "\u001b[31m\u001b[0m", "invalid!id"], "live");

    expect(result).toContain("Available models:");
    expect(result).toContain("Note: Available models: Availability depends on your Copilot tier");
    expect(result).not.toContain("Anthropic:");
    expect(result).not.toContain("OpenAI   :");
    expect(result).not.toContain("Google   :");
    expect(result).not.toContain("Other    :");
  });

  it("preserves discovered order within provider groups", () => {
    const result = formatAvailableModels(
      ["gpt-5.4-mini", "claude-sonnet-4.5", "gpt-5.4", "claude-haiku-4.5"],
      "live",
    );

    expect(result).toContain("Anthropic: claude-sonnet-4.5, claude-haiku-4.5");
    expect(result).toContain("OpenAI   : gpt-5.4-mini, gpt-5.4");
  });

  it("filters invalid model IDs and deduplicates", () => {
    const result = formatAvailableModels(
      [
        "claude-\u001b[31msonnet-4.6\u001b[0m",
        "gpt-5.4",
        "gpt-\u001b[31m5.4\u001b[0m",
        "gpt-5.4\nmini",
        "gpt-5.4;rm -rf /",
      ],
      "live",
    );

    expect(result).toContain("claude-sonnet-4.6");
    expect(result).toContain("gpt-5.4");
    expect(result).not.toContain("gpt-5.4, gpt-5.4");
    expect(result).not.toContain("gpt-5.4 mini");
    expect(result).not.toContain("gpt-5.4;rm -rf /");
    expect(result).not.toContain("\u001b[31m");
  });
});

describe("formatAvailableModels live-only annotation", () => {
  // A live-discovered id that is NOT in the canonical SUPPORTED_MODELS registry
  // would be REJECTED by offline `convene --model` validation, so it must be
  // visibly flagged as live-only (bug F02 residual — #1094).
  it("annotates live-discovered ids absent from the static registry", () => {
    const result = formatAvailableModels(
      ["claude-sonnet-4.6", "gpt-5.9", "gemini-2.5-pro"],
      "live",
    );

    expect(result).toContain("gpt-5.9 (live-only — not offline-validatable)");
    expect(result).toContain("gemini-2.5-pro (live-only — not offline-validatable)");
  });

  it("does not annotate live-discovered ids that are in the static registry", () => {
    const result = formatAvailableModels(
      ["claude-sonnet-4.6", "gpt-5.9", "gemini-2.5-pro"],
      "live",
    );

    expect(result).not.toContain("claude-sonnet-4.6 (live-only");
    expect(result).toContain("Anthropic: claude-sonnet-4.6");
  });

  it("explains the live-only marker with a convene --model legend when present", () => {
    const result = formatAvailableModels(["claude-sonnet-4.6", "gpt-5.9"], "live");

    expect(result).toContain("council convene --model");
  });

  it("omits the live-only marker and legend entirely under static fallback", () => {
    const result = formatAvailableModels(
      ["claude-sonnet-4.6", "gpt-5.9", "gemini-2.5-pro"],
      "static",
    );

    expect(result).not.toContain("live-only");
    expect(result).not.toContain("council convene --model");
  });

  it("omits the legend when every live-discovered id is offline-validatable", () => {
    const result = formatAvailableModels(["claude-sonnet-4.6", "gpt-5.4", "auto"], "live");

    expect(result).not.toContain("live-only");
  });
});

describe("formatAvailableModels context-aware note (#753)", () => {
  // The closing note must not claim a static "Known models" list when the
  // catalog was live-discovered — that wording is misleading for source="live".
  it("uses live-discovered wording in the note when source is live", () => {
    const result = formatAvailableModels(["claude-sonnet-4.6", "gpt-5.4"], "live");

    expect(result).toContain("Note: Available models:");
    expect(result).not.toContain("Note: Known models:");
  });

  it("keeps the known-models wording in the note when source is static", () => {
    const result = formatAvailableModels(["claude-sonnet-4.5", "gpt-5.4"], "static");

    expect(result).toContain("Note: Known models:");
    expect(result).not.toContain("Note: Available models:");
  });
});

describe("buildModelsCommand", () => {
  it("prints available models grouped by provider", async () => {
    const discoverModels = vi.fn(async () => ({
      models: ["claude-sonnet-4.6", "gpt-5.4", "gemini-2.5-pro"],
      source: "live" as const,
    }));

    const output = await runModels([], { discoverModels });

    expect(output).toContain("Available models:");
    expect(output).toContain("Anthropic: claude-sonnet-4.6");
    expect(output).toContain("OpenAI   : gpt-5.4");
    expect(output).toContain("Google   : gemini-2.5-pro");
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("surfaces discovery errors on stderr and exits non-zero", async () => {
    const discoverModels = vi.fn(async () => {
      throw new Error("engine unavailable");
    });

    const { stdout, stderr, error } = await runModelsWithResult([], { discoverModels });

    expect(stdout).toBe("");
    expect(stderr).toContain("engine unavailable");
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("engine unavailable");
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("labels static fallback when live discovery is unavailable", async () => {
    const discoverModels = vi.fn(async () => ({
      models: ["claude-haiku-4.5", "claude-sonnet-4.5", "gpt-5.4"],
      source: "static" as const,
    }));

    const output = await runModels([], { discoverModels });

    expect(output).toContain("Known models (live discovery unavailable):");
    expect(output).toContain("Anthropic: claude-haiku-4.5, claude-sonnet-4.5");
    expect(output).toContain("OpenAI   : gpt-5.4");
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("command has description in help", () => {
    const help = buildModelsCommand({}).helpInformation();

    expect(help).toContain("List available Copilot models");
  });
});
