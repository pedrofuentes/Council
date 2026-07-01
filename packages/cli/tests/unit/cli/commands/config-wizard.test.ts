/**
 * Tests for `council config wizard`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildConfigCommand } from "../../../../src/cli/commands/config.js";
import { loadConfig, updateConfigField } from "../../../../src/config/index.js";
import type { Writer } from "../../../../src/cli/commands/writer.js";

interface CapturedOutput {
  readonly stream: PassThrough;
  text(): string;
}

interface ConfigCommandDeps {
  readonly write?: Writer;
  readonly writeError?: Writer;
  readonly wizard?: {
    readonly input: NodeJS.ReadableStream;
    readonly output: NodeJS.WritableStream;
    readonly discoverModels: () => Promise<{
      readonly models: readonly string[];
      readonly source: "live" | "static";
    }>;
  };
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

function createInput(text: string): NodeJS.ReadableStream {
  const input = new PassThrough();
  Object.defineProperty(input, "isTTY", {
    value: true,
    configurable: true,
  });
  input.end(text);
  return input;
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
    undefined,
    deps.wizard,
  );
  cmd.exitOverride();
  await cmd.parseAsync(["node", "council-config", ...args]).catch(() => undefined);
  return { stdout, stderr };
}

describe("buildConfigCommand config wizard", () => {
  let testHome: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(process.cwd(), ".tmp-config-wizard-"));
    delete process.env["COUNCIL_HOME"];
    process.env["COUNCIL_DATA_HOME"] = testHome;
  });

  afterEach(async () => {
    if (originalCouncilHome === undefined) {
      delete process.env["COUNCIL_HOME"];
    } else {
      process.env["COUNCIL_HOME"] = originalCouncilHome;
    }
    if (originalDataHome === undefined) {
      delete process.env["COUNCIL_DATA_HOME"];
    } else {
      process.env["COUNCIL_DATA_HOME"] = originalDataHome;
    }
    await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("writes scripted wizard answers through the config update path", async () => {
    const output = createCapturedOutput();
    const discoverModels = vi.fn(async () => ({
      models: ["claude-sonnet-4.5", "gpt-5.4"],
      source: "live" as const,
    }));
    const input = createInput(
      [
        "2",
        "mock",
        "6",
        "4",
        "333",
        "yes",
        "12",
        "650",
        "750",
        "ask",
        ".pdf, docx",
        "75",
        "120000",
        "regenerate",
        "2",
        "30",
        "~/CustomCouncil",
      ].join("\n") + "\n",
    );

    const { stderr } = await runConfig(["wizard"], {
      write: (text) => output.stream.write(text),
      wizard: {
        input,
        output: output.stream,
        discoverModels,
      },
    });

    expect(stderr).toBe("");
    expect(discoverModels).toHaveBeenCalledTimes(1);
    expect(output.text()).toContain("Config wizard complete.");
    const config = await loadConfig();
    expect(config.defaults).toMatchObject({
      model: "gpt-5.4",
      engine: "mock",
      maxRounds: 6,
      maxExperts: 4,
      maxWordsPerResponse: 333,
    });
    expect(config.telemetry.enabled).toBe(true);
    expect(config.chat).toMatchObject({
      recentTurnCount: 12,
      summaryMaxWords: 650,
      longConversationWarning: 750,
    });
    expect(config.documents).toMatchObject({
      aiExtraction: "ask",
      aiExtractionAllowedExtensions: [".pdf", ".docx"],
      maxFileSizeMB: 75,
    });
    expect(config.conclude.maxTranscriptChars).toBe(120000);
    expect(config.qualityGate).toMatchObject({
      mode: "regenerate",
      maxRegenerations: 2,
    });
    expect(config.expert.recencyHalfLifeDays).toBe(30);
    expect(config.paths.dataHome).toBe("~/CustomCouncil");
  });

  it("aborts on EOF without changing persisted config", async () => {
    await updateConfigField("defaults.model", "previous-model");
    await updateConfigField("defaults.engine", "mock");
    const before = await loadConfig();
    const output = createCapturedOutput();
    const discoverModels = vi.fn(async () => ({
      models: ["new-model"],
      source: "live" as const,
    }));

    const { stderr } = await runConfig(["wizard"], {
      write: (text) => output.stream.write(text),
      wizard: {
        input: createInput(""),
        output: output.stream,
        discoverModels,
      },
    });

    expect(stderr).toContain("Config wizard aborted before completion.");
    expect(output.text()).not.toContain("Config wizard complete.");
    expect(await loadConfig()).toEqual(before);
  });

  it("leaves persisted config unchanged when a later wizard answer is invalid", async () => {
    await updateConfigField("defaults.model", "previous-model");
    await updateConfigField("defaults.engine", "mock");
    await updateConfigField("defaults.maxRounds", 7);
    const before = await loadConfig();
    const output = createCapturedOutput();
    const discoverModels = vi.fn(async () => ({
      models: ["new-model"],
      source: "live" as const,
    }));
    const input = createInput(["1", "copilot", "not-a-number"].join("\n") + "\n");

    const { stderr } = await runConfig(["wizard"], {
      write: (text) => output.stream.write(text),
      wizard: {
        input,
        output: output.stream,
        discoverModels,
      },
    });

    expect(stderr).toContain("Config value for defaults.maxRounds must be an integer.");
    expect(output.text()).not.toContain("Config wizard complete.");
    expect(await loadConfig()).toEqual(before);
  });

  it("strips terminal controls from discovered model ids before listing and echoing the selection", async () => {
    const output = createCapturedOutput();
    const rawModel = "gpt\u001B[31m-\u0085evil\u202E";
    const discoverModels = vi.fn(async () => ({
      models: [rawModel],
      source: "live" as const,
    }));
    const input = createInput(
      ["1", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""].join("\n") + "\n",
    );

    const { stderr } = await runConfig(["wizard"], {
      write: (text) => output.stream.write(text),
      wizard: {
        input,
        output: output.stream,
        discoverModels,
      },
    });

    const text = output.text();
    expect(stderr).toBe("");
    expect(text).toContain("1. gpt-evil (recommended)");
    expect(text).toContain("Set defaults.model = gpt-evil");
    expect(text).not.toContain(rawModel);
    for (const codePoint of [0x1b, 0x85, 0x202e]) {
      expect(text).not.toContain(String.fromCodePoint(codePoint));
    }

    const config = await loadConfig();
    expect(config.defaults.model).toBe(rawModel);
  });

  it("strips terminal controls from wizard string and array display while preserving persisted values", async () => {
    const output = createCapturedOutput();
    const rawModel = "gpt\u001B[31m-\u0085evil\u202E";
    const rawCurrentExtension = ".txt\u001B[32mY\u202E";
    const rawSelectedExtension = "md\u001B[31mX\u202E";
    await updateConfigField("documents.aiExtractionAllowedExtensions", [rawCurrentExtension]);
    const discoverModels = vi.fn(async () => ({
      models: [rawModel],
      source: "live" as const,
    }));
    const input = createInput(
      ["", "", "", "", "", "", "", "", "", "", rawSelectedExtension, "", "", "", "", "", ""].join(
        "\n",
      ) + "\n",
    );

    const { stderr } = await runConfig(["wizard"], {
      write: (text) => output.stream.write(text),
      wizard: {
        input,
        output: output.stream,
        discoverModels,
      },
    });

    const text = output.text();
    expect(stderr).toBe("");
    expect(text).toContain("1. gpt-evil (recommended)");
    expect(text).toContain("Set defaults.model = gpt-evil");
    expect(text).toContain(
      "AI extraction extensions (comma-separated, blank for current) [.txtY]: ",
    );
    expect(text).toContain("Set documents.aiExtractionAllowedExtensions = .mdx");
    expect(text).not.toContain(rawModel);
    expect(text).not.toContain(rawCurrentExtension);
    expect(text).not.toContain(`.${rawSelectedExtension.toLowerCase()}`);
    for (const codePoint of [0x1b, 0x85, 0x202e]) {
      expect(text).not.toContain(String.fromCodePoint(codePoint));
    }

    const config = await loadConfig();
    expect(config.defaults.model).toBe(rawModel);
    expect(config.documents.aiExtractionAllowedExtensions).toEqual([
      `.${rawSelectedExtension.toLowerCase()}`,
    ]);
  });

  it("collapses multiline wizard values to one terminal line while preserving persisted values", async () => {
    const output = createCapturedOutput();
    const rawModel = "a\r\nINJECTED";
    const rawCurrentExtension = "md\nX";
    await updateConfigField("documents.aiExtractionAllowedExtensions", [rawCurrentExtension]);
    const discoverModels = vi.fn(async () => ({
      models: [rawModel],
      source: "live" as const,
    }));
    const input = createInput(
      ["1", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""].join("\n") + "\n",
    );

    const { stderr } = await runConfig(["wizard"], {
      write: (text) => output.stream.write(text),
      wizard: {
        input,
        output: output.stream,
        discoverModels,
      },
    });

    const text = output.text();
    expect(stderr).toBe("");
    expect(text).toContain("1. a INJECTED (recommended)");
    expect(text).toContain("Set defaults.model = a INJECTED\n");
    expect(text).toContain(
      "AI extraction extensions (comma-separated, blank for current) [md X]: ",
    );
    expect(text).toContain("Set documents.aiExtractionAllowedExtensions = md X\n");
    expect(text).not.toContain(rawModel);
    expect(text).not.toContain(rawCurrentExtension);

    const config = await loadConfig();
    expect(config.defaults.model).toBe(rawModel);
    expect(config.documents.aiExtractionAllowedExtensions).toEqual([rawCurrentExtension]);
  });

  it("sanitizes discovered model ids in invalid wizard choice errors", async () => {
    const output = createCapturedOutput();
    const rawModel = "gpt\u001B[31m\r\nEVIL";
    const discoverModels = vi.fn(async () => ({
      models: [rawModel],
      source: "live" as const,
    }));
    const input = createInput("not-a-choice\n");

    const { stderr } = await runConfig(["wizard"], {
      write: (text) => output.stream.write(text),
      wizard: {
        input,
        output: output.stream,
        discoverModels,
      },
    });

    expect(stderr).toContain("Config value for defaults.model must be one of: gpt EVIL");
    expect(stderr).not.toContain(rawModel);
    expect(stderr).not.toContain("\u001B");
    expect(stderr).not.toContain("\r");
    expect(stderr).not.toContain("gpt\nEVIL");
  });

  it("prompts for and persists the quality gate, expert recency, and paths groups", async () => {
    const output = createCapturedOutput();
    const discoverModels = vi.fn(async () => ({
      models: ["claude-sonnet-4.5"],
      source: "live" as const,
    }));
    // Model + 12 existing prompts left blank, then the four new prompts.
    const input = createInput(
      [
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "regenerate",
        "3",
        "45",
        "~/PromptedCouncil",
      ].join("\n") + "\n",
    );

    const { stderr } = await runConfig(["wizard"], {
      write: (text) => output.stream.write(text),
      wizard: {
        input,
        output: output.stream,
        discoverModels,
      },
    });

    const text = output.text();
    expect(stderr).toBe("");
    expect(text).toContain("Quality gate mode");
    expect(text).toContain("Quality gate max regenerations");
    expect(text).toContain("Expert source recency half-life");
    expect(text).toContain("Data home directory");
    expect(text).toContain("Config wizard complete.");

    const config = await loadConfig();
    expect(config.qualityGate).toMatchObject({ mode: "regenerate", maxRegenerations: 3 });
    expect(config.expert.recencyHalfLifeDays).toBe(45);
    expect(config.paths.dataHome).toBe("~/PromptedCouncil");
  });

  it("rejects an invalid quality gate mode entered in the wizard (#1864)", async () => {
    await updateConfigField("defaults.model", "previous-model");
    await updateConfigField("qualityGate.mode", "warn");
    const before = await loadConfig();
    const output = createCapturedOutput();
    const discoverModels = vi.fn(async () => ({
      models: ["claude-sonnet-4.5"],
      source: "live" as const,
    }));
    // Model pick, then 12 blank answers, then an invalid qualityGate.mode value.
    const input = createInput(
      ["1", "", "", "", "", "", "", "", "", "", "", "", "", "bogus"].join("\n") + "\n",
    );

    const { stderr } = await runConfig(["wizard"], {
      write: (text) => output.stream.write(text),
      wizard: {
        input,
        output: output.stream,
        discoverModels,
      },
    });

    expect(stderr).toContain(
      "Config value for qualityGate.mode must be one of: off, warn, regenerate",
    );
    expect(output.text()).not.toContain("Config wizard complete.");
    // The invalid answer must not mutate persisted config.
    expect(await loadConfig()).toEqual(before);
  });
});
