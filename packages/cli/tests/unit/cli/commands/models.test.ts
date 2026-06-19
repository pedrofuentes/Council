/**
 * Tests for `council models`.
 */
import { describe, expect, it, vi } from "vitest";

import { buildModelsCommand, formatAvailableModels } from "../../../../src/cli/commands/models.js";
import type { Writer } from "../../../../src/cli/commands/writer.js";

interface ModelsDepsLike {
  readonly write?: Writer;
  readonly discoverModels?: () => Promise<{
    models: readonly string[];
    source: "live" | "static";
  }>;
}

const buildModelsCommandWithDeps = buildModelsCommand as unknown as (
  deps: ModelsDepsLike,
) => ReturnType<typeof buildModelsCommand>;

async function runModels(args: readonly string[], deps: ModelsDepsLike = {}): Promise<string> {
  let captured = "";
  const cmd = buildModelsCommandWithDeps({
    ...deps,
    write: (chunk: string) => {
      captured += chunk;
    },
  });
  cmd.exitOverride();
  await cmd.parseAsync(["node", "council-models", ...args]).catch(() => undefined);
  return captured;
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
    expect(result).toContain("Known models: Availability depends on your Copilot tier");
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

  it("includes known model identifiers from the real catalog", () => {
    const result = formatAvailableModels(
      ["claude-sonnet-4.5", "gpt-4.1", "gemini-2.5-pro"],
      "live",
    );

    // Test known model IDs from requirements
    expect(result).toContain("claude-sonnet-4.5");
    expect(result).toContain("gpt-4.1");
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
    const help = buildModelsCommandWithDeps({}).helpInformation();

    expect(help).toContain("List available Copilot models");
  });
});
