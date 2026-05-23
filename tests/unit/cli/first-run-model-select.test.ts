import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { selectModelInteractively } from "../../../src/cli/first-run-model-select.js";

interface CapturedOutput {
  readonly stream: PassThrough;
  text(): string;
}

function createInput(text: string, isTTY = true): NodeJS.ReadableStream {
  const input = new PassThrough();
  Object.defineProperty(input, "isTTY", {
    value: isTTY,
    configurable: true,
  });
  input.end(text);
  return input;
}

function createCapturedOutput(): CapturedOutput {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer | string) => {
    chunks.push(chunk.toString());
  });
  return {
    stream,
    text(): string {
      return chunks.join("");
    },
  };
}

describe("selectModelInteractively", () => {
  const discoverModels = vi.fn();
  const updateConfig = vi.fn();

  beforeEach(() => {
    discoverModels.mockReset();
    updateConfig.mockReset();
  });

  it("shows preferred ordering and selects the recommended model on Enter", async () => {
    discoverModels.mockResolvedValue({
      models: ["gpt-5.4-mini", "claude-sonnet-4.6", "gpt-5.4", "claude-sonnet-4.5"],
      source: "live",
    });
    const output = createCapturedOutput();

    const selected = await selectModelInteractively({
      write: (text) => output.stream.write(text),
      input: createInput("\n"),
      output: output.stream,
      discoverModels,
      updateConfig,
    });

    expect(selected).toBe("claude-sonnet-4.5");
    expect(updateConfig).toHaveBeenCalledWith("defaults.model", "claude-sonnet-4.5");

    const text = output.text();
    expect(text).toContain("Welcome to Council! Let's set up your default AI model.");
    expect(text).toContain("1. claude-sonnet-4.5 (recommended)");
    expect(text).toContain("2. claude-sonnet-4.6");
    expect(text).toContain("3. gpt-5.4");
    expect(text).toContain("4. gpt-5.4-mini");
    expect(text).toContain("✓ Default model set to claude-sonnet-4.5");
    expect(text).toContain("Run 'council doctor' to verify your full setup.");
  });

  it("warns on static fallback and respects explicit numbered selection", async () => {
    discoverModels.mockResolvedValue({
      models: ["gpt-5.4", "claude-sonnet-4.6", "claude-sonnet-4.5"],
      source: "static",
    });
    const output = createCapturedOutput();

    const selected = await selectModelInteractively({
      write: (text) => output.stream.write(text),
      input: createInput("2\n"),
      output: output.stream,
      discoverModels,
      updateConfig,
    });

    expect(selected).toBe("claude-sonnet-4.6");
    expect(updateConfig).toHaveBeenCalledWith("defaults.model", "claude-sonnet-4.6");
    expect(output.text()).toContain("Warning: Live model discovery failed");
  });

  it("falls back to the recommended model after three invalid attempts", async () => {
    discoverModels.mockResolvedValue({
      models: ["gpt-5.4", "claude-sonnet-4.5"],
      source: "live",
    });
    const output = createCapturedOutput();

    const selected = await selectModelInteractively({
      write: (text) => output.stream.write(text),
      input: createInput("9\n0\nabc\n"),
      output: output.stream,
      discoverModels,
      updateConfig,
    });

    expect(selected).toBe("claude-sonnet-4.5");
    expect(updateConfig).toHaveBeenCalledWith("defaults.model", "claude-sonnet-4.5");
    expect(output.text()).toContain("Too many invalid selections; using the recommended model.");
  });

  it("uses the recommended model automatically in non-interactive mode", async () => {
    discoverModels.mockResolvedValue({
      models: ["gpt-5.4", "claude-sonnet-4.6", "gpt-5.4-mini"],
      source: "live",
    });
    const output = createCapturedOutput();

    const selected = await selectModelInteractively({
      write: (text) => output.stream.write(text),
      input: createInput("", false),
      output: output.stream,
      discoverModels,
      updateConfig,
    });

    expect(selected).toBe("claude-sonnet-4.6");
    expect(updateConfig).toHaveBeenCalledWith("defaults.model", "claude-sonnet-4.6");
    expect(output.text()).toContain("Non-interactive session detected; using recommended model claude-sonnet-4.6.");
  });

  it("fails with a doctor hint when no models are available", async () => {
    discoverModels.mockResolvedValue({
      models: [],
      source: "live",
    });
    const output = createCapturedOutput();

    await expect(
      selectModelInteractively({
        write: (text) => output.stream.write(text),
        input: createInput("\n"),
        output: output.stream,
        discoverModels,
        updateConfig,
      }),
    ).rejects.toThrow(/council doctor/i);

    expect(updateConfig).not.toHaveBeenCalled();
    expect(output.text()).toContain("Run 'council doctor' to verify your full setup.");
  });
});
