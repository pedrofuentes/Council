/**
 * Tests for `council doctor`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDoctorCommand, checkNodeVersion } from "../../../../src/cli/commands/doctor.js";
import type { Writer } from "../../../../src/cli/commands/writer.js";

interface SpinnerLike {
  start(label: string): void;
  stop(): void;
}

interface DoctorDepsLike {
  readonly write?: Writer;
  readonly version?: string;
  readonly onlineProbe?: (model: string) => Promise<{ ok: boolean; detail: string }>;
  readonly onlineProbeTimeoutMs?: number;
  readonly discoverModels?: () => Promise<{
    models: readonly string[];
    source: "live" | "static";
  }>;
  readonly createSpinner?: () => SpinnerLike;
  readonly resolveCliPath?: () => string | undefined;
}

const buildDoctorCommandWithDeps = buildDoctorCommand as unknown as (
  deps: DoctorDepsLike,
) => ReturnType<typeof buildDoctorCommand>;

async function runDoctor(args: readonly string[], deps: DoctorDepsLike = {}): Promise<string> {
  let captured = "";
  const cmd = buildDoctorCommandWithDeps({
    ...deps,
    write: (chunk: string) => {
      captured += chunk;
    },
  });
  cmd.exitOverride();
  await cmd.parseAsync(["node", "council-doctor", ...args]).catch(() => undefined);
  return captured;
}

describe("buildDoctorCommand", () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalDataHome: string | undefined;
  let originalCliPath: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-doctor-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    originalDataHome = process.env["COUNCIL_DATA_HOME"];
    originalCliPath = process.env["COPILOT_CLI_PATH"];
    process.env["COUNCIL_HOME"] = testHome;
    delete process.env["COPILOT_CLI_PATH"];
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    if (originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
    else process.env["COUNCIL_DATA_HOME"] = originalDataHome;
    if (originalCliPath === undefined) delete process.env["COPILOT_CLI_PATH"];
    else process.env["COPILOT_CLI_PATH"] = originalCliPath;
    await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("doctor runs online check by default", async () => {
    const onlineProbe = vi.fn(async (model: string) => ({
      ok: true,
      detail: `probe ok for ${model}`,
    }));

    const output = await runDoctor([], { onlineProbe });

    expect(onlineProbe).toHaveBeenCalledTimes(1);
    expect(onlineProbe).toHaveBeenCalledWith("claude-sonnet-4.5");
    expect(output).toContain("Default model (claude-sonnet-4.5) session created successfully");
  });

  it("doctor --online still works for backwards compatibility", async () => {
    const onlineProbe = vi.fn(async (model: string) => ({
      ok: true,
      detail: `probe ok for ${model}`,
    }));

    const output = await runDoctor(["--online"], { onlineProbe });

    expect(onlineProbe).toHaveBeenCalledTimes(1);
    expect(onlineProbe).toHaveBeenCalledWith("claude-sonnet-4.5");
    expect(output).toContain("Default model (claude-sonnet-4.5) session created successfully");
  });

  it("doctor with failed probe shows alternatives and config set fix", async () => {
    await fs.mkdir(testHome, { recursive: true });
    await fs.writeFile(
      path.join(testHome, "config.yaml"),
      "defaults:\n  engine: copilot\n  model: claude-sonnet-4-20250514\n  maxRounds: 4\n",
      "utf-8",
    );

    const onlineProbe = vi.fn(async () => ({ ok: false, detail: "model not found" }));
    const discoverModels = vi.fn(async () => ({
      models: ["claude-sonnet-4.5", "claude-sonnet-4.6", "gpt-5.4", "gpt-5.4-mini"],
      source: "live" as const,
    }));

    const output = await runDoctor([], { onlineProbe, discoverModels });

    expect(onlineProbe).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
    expect(output).toContain(
      "Default model (claude-sonnet-4-20250514) is not accessible: model not found",
    );
    expect(output).toContain("Available alternatives:");
    expect(output).toContain("claude-sonnet-4.5, claude-sonnet-4.6, gpt-5.4, gpt-5.4-mini");
    expect(output).toContain("Fix: council config set defaults.model claude-sonnet-4.5");
  });

  it("doctor with thrown probe still shows alternatives", async () => {
    const onlineProbe = vi.fn(async () => {
      throw new Error("session creation failed");
    });
    const discoverModels = vi.fn(async () => ({
      models: ["claude-sonnet-4.5", "gpt-5.4", "gpt-5.4-mini"],
      source: "live" as const,
    }));

    const output = await runDoctor([], { onlineProbe, discoverModels });

    expect(onlineProbe).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
    expect(output).toContain(
      "Default model (claude-sonnet-4.5) probe failed: session creation failed",
    );
    expect(output).toContain("Available alternatives:");
    expect(output).toContain("gpt-5.4, gpt-5.4-mini");
    expect(output).toContain("Fix: council config set defaults.model gpt-5.4");
  });

  it("doctor with failed probe degrades gracefully when model discovery throws", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: false, detail: "model not found" }));
    const discoverModels = vi.fn(async () => {
      throw new Error("discovery unavailable");
    });

    const output = await runDoctor([], { onlineProbe, discoverModels });

    expect(onlineProbe).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
    expect(output).toContain(
      "Default model (claude-sonnet-4.5) is not accessible: model not found",
    );
    expect(output).not.toContain("Available alternatives:");
    expect(output).not.toContain("discovery unavailable");
  });

  it("doctor bounds a hung online probe with a timeout instead of hanging", async () => {
    const onlineProbe = vi.fn(() => new Promise<{ ok: boolean; detail: string }>(() => undefined));
    const discoverModels = vi.fn(async () => ({
      models: ["claude-sonnet-4.5", "gpt-5.4"],
      source: "live" as const,
    }));

    const output = await runDoctor([], { onlineProbe, discoverModels, onlineProbeTimeoutMs: 50 });

    expect(onlineProbe).toHaveBeenCalledTimes(1);
    expect(output).toContain("Default model (claude-sonnet-4.5) probe timed out");
    expect(output).toContain("Some checks failed");
  });

  it("doctor --offline skips model probe", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: true, detail: "should not run" }));

    const output = await runDoctor(["--offline"], { onlineProbe });

    expect(onlineProbe).not.toHaveBeenCalled();
    expect(output).toMatch(/Council v\d+\.\d+\.\d+/);
    expect(output).not.toContain("Default model (");
  });

  it("doctor displays the Council version", async () => {
    const output = await runDoctor(["--offline"], { version: "9.9.9" });

    expect(output).toContain("Council v9.9.9");
  });

  it("doctor no longer prints the old plain-text 'Council Doctor' header", async () => {
    const output = await runDoctor(["--offline"], { version: "9.9.9" });

    expect(output).not.toContain("Council Doctor");
  });

  it("doctor uses COUNCIL_DATA_HOME for visible paths when COUNCIL_HOME is unset", async () => {
    const customDataHome = path.join(testHome, "custom-data-home");
    delete process.env["COUNCIL_HOME"];
    process.env["COUNCIL_DATA_HOME"] = customDataHome;

    const output = await runDoctor(["--offline"]);

    expect(output).toContain(`Council home\n   ${customDataHome}`);
    expect(output).toContain(`Council data home\n   ${customDataHome}`);
    expect(output).toContain(`Path: ${path.join(customDataHome, "config.yaml")}`);
  });

  it("doctor --models lists live discovered models", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: true, detail: "OK" }));
    const discoverModels = vi.fn(async () => ({
      models: ["claude-sonnet-4.6", "gpt-5.4", "gemini-2.5-pro"],
      source: "live" as const,
    }));

    const output = await runDoctor(["--models", "--offline"], { onlineProbe, discoverModels });

    expect(output).toContain("Available models:");
    expect(output).toContain("Anthropic: claude-sonnet-4.6");
    expect(output).toContain("OpenAI   : gpt-5.4");
    expect(output).toContain("Google   : gemini-2.5-pro");
    expect(output).toContain("Availability depends on your Copilot tier");
    expect(onlineProbe).not.toHaveBeenCalled();
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("doctor --models labels static fallback when live discovery is unavailable", async () => {
    const discoverModels = vi.fn(async () => ({
      models: ["claude-haiku-4.5", "claude-sonnet-4.5", "gpt-5.4", "gpt-5.4-mini"],
      source: "static" as const,
    }));

    const output = await runDoctor(["--models", "--offline"], { discoverModels });

    expect(output).toContain("Known models (live discovery unavailable):");
    expect(output).toContain("Anthropic: claude-haiku-4.5, claude-sonnet-4.5");
    expect(output).toContain("OpenAI   : gpt-5.4, gpt-5.4-mini");
    expect(output).not.toContain("Google");
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("doctor --models preserves discovered order within provider groups", async () => {
    const discoverModels = vi.fn(async () => ({
      models: ["gpt-5.4-mini", "claude-sonnet-4.5", "gpt-5.4", "claude-haiku-4.5"],
      source: "live" as const,
    }));

    const output = await runDoctor(["--models", "--offline"], { discoverModels });

    expect(output).toContain("Available models:");
    expect(output).toContain("Anthropic: claude-sonnet-4.5, claude-haiku-4.5");
    expect(output).toContain("OpenAI   : gpt-5.4-mini, gpt-5.4");
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("doctor --models filters invalid discovered model IDs and deduplicates sanitized matches", async () => {
    const discoverModels = vi.fn(async () => ({
      models: [
        "claude-\u001b[31msonnet-4.6\u001b[0m",
        "gpt-5.4",
        "gpt-\u001b[31m5.4\u001b[0m",
        "gpt-5.4\nmini",
        "gpt-5.4;rm -rf /",
      ],
      source: "live" as const,
    }));

    const output = await runDoctor(["--models", "--offline"], { discoverModels });

    expect(output).toContain("Anthropic: claude-sonnet-4.6");
    expect(output).toContain("OpenAI   : gpt-5.4");
    expect(output).not.toContain("gpt-5.4, gpt-5.4");
    expect(output).not.toContain("gpt-5.4 mini");
    expect(output).not.toContain("gpt-5.4;rm -rf /");
    expect(output).not.toContain("\u001b[31m");
    expect(output).not.toContain("gpt-5.4\nmini");
  });

  it("doctor excludes shell metacharacters and option-like IDs from remediation alternatives", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: false, detail: "model not found" }));
    const discoverModels = vi.fn(async () => ({
      models: [
        "claude-sonnet-4.5",
        "gpt-5.4",
        "gpt-\u001b[31m5.4\u001b[0m",
        "--help",
        "-x",
        "gpt-5.4;rm -rf /",
      ],
      source: "live" as const,
    }));

    const output = await runDoctor([], { onlineProbe, discoverModels });
    const alternativesBlock =
      output.match(/Available alternatives:\n([\s\S]*?)\n\s*Fix:/)?.[1] ?? "";

    expect(output).toContain("Available alternatives:");
    expect(output).toContain("Fix: council config set defaults.model gpt-5.4");
    expect(alternativesBlock).toContain("     gpt-5.4");
    expect(alternativesBlock).not.toContain("gpt-5.4, gpt-5.4");
    expect(alternativesBlock).not.toContain("--help");
    expect(alternativesBlock).not.toContain("-x");
    expect(alternativesBlock).not.toContain("gpt-5.4;rm -rf /");
    expect(output).not.toContain("\u001b[31m");
  });

  it("doctor excludes discovered models that sanitize to the active model", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: false, detail: "model not found" }));
    const discoverModels = vi.fn(async () => ({
      models: ["claude-\u001b[31msonnet-4.5\u001b[0m", "gpt-5.4-mini"],
      source: "live" as const,
    }));

    const output = await runDoctor([], { onlineProbe, discoverModels });

    expect(output).toContain("Available alternatives:");
    expect(output).toContain("     gpt-5.4-mini");
    expect(output).toContain("Fix: council config set defaults.model gpt-5.4-mini");
    expect(output).not.toContain("claude-sonnet-4.5, gpt-5.4-mini");
  });

  it("doctor omits remediation guidance when no valid alternatives remain", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: false, detail: "model not found" }));
    const discoverModels = vi.fn(async () => ({
      models: ["claude-\u001b[31msonnet-4.5\u001b[0m", "gpt-5.4\nmini", "gpt-5.4;rm -rf /"],
      source: "live" as const,
    }));

    const output = await runDoctor([], { onlineProbe, discoverModels });

    expect(output).toContain(
      "Default model (claude-sonnet-4.5) is not accessible: model not found",
    );
    expect(output).not.toContain("Available alternatives:");
    expect(output).not.toContain("Fix: council config set defaults.model");
  });

  it("doctor help describes the offline and models flags", () => {
    const help = buildDoctorCommandWithDeps({}).helpInformation();

    expect(help).toContain("Skip online model probe");
    expect(help).toMatch(/List available Copilot models \(live discovery with static\s+fallback\)/);
  });

  it("doctor shows Configuration section with defaults", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: true, detail: "ok" }));
    const output = await runDoctor([], { onlineProbe });

    expect(output).toContain("Config");
    expect(output).toContain("Path:");
    expect(output).toContain("config.yaml");
    expect(output).toContain("Engine: copilot");
    expect(output).toContain("Rounds: 4");
  });

  it("doctor shows Configuration with custom config values", async () => {
    await fs.mkdir(testHome, { recursive: true });
    await fs.writeFile(
      path.join(testHome, "config.yaml"),
      "defaults:\n  engine: mock\n  maxRounds: 7\n",
      "utf-8",
    );

    const onlineProbe = vi.fn(async () => ({ ok: true, detail: "ok" }));
    const output = await runDoctor([], { onlineProbe });

    expect(output).toContain("Engine: mock");
    expect(output).toContain("Rounds: 7");
  });

  it("doctor shows warning when config is invalid", async () => {
    await fs.mkdir(testHome, { recursive: true });
    await fs.writeFile(path.join(testHome, "config.yaml"), "{{invalid yaml", "utf-8");

    const output = await runDoctor([]);

    expect(output).toContain("Could not load configuration");
  });

  it("doctor drives the injected spinner around each check", async () => {
    const start = vi.fn();
    const stop = vi.fn();
    const createSpinner = vi.fn(() => ({ start, stop }));
    const onlineProbe = vi.fn(async () => ({ ok: true, detail: "ok" }));

    await runDoctor([], { onlineProbe, createSpinner });

    expect(createSpinner).toHaveBeenCalledTimes(1);
    // 7 base checks + 1 default-model-access check (online runs by default).
    expect(start).toHaveBeenCalledTimes(8);
    expect(stop).toHaveBeenCalledTimes(8);
    expect(start).toHaveBeenCalledWith("Node.js version");
    expect(start).toHaveBeenCalledWith("Copilot CLI");
    expect(start).toHaveBeenCalledWith("Default model access");
  });

  it("doctor report content is byte-identical whether or not a spinner is injected", async () => {
    const probe = (): Promise<{ ok: boolean; detail: string }> =>
      Promise.resolve({ ok: true, detail: "ok" });

    const noSpinner = await runDoctor(["--offline"], { onlineProbe: vi.fn(probe) });
    const withSpinner = await runDoctor(["--offline"], {
      onlineProbe: vi.fn(probe),
      createSpinner: () => ({ start: vi.fn(), stop: vi.fn() }),
    });

    expect(withSpinner).toBe(noSpinner);
  });

  it("doctor passes the Copilot CLI check when the entry resolves", async () => {
    const cliEntry = path.join(testHome, "npm-loader.js");
    await fs.writeFile(cliEntry, "// loader", "utf-8");

    const output = await runDoctor(["--offline"], { resolveCliPath: () => cliEntry });

    expect(output).toContain("Copilot CLI");
    expect(output).not.toContain("known Windows path-resolution issue");
  });

  it("doctor prints actionable remediation when the Copilot CLI path cannot be resolved", async () => {
    const output = await runDoctor(["--offline"], { resolveCliPath: () => undefined });

    expect(output).toContain("Copilot CLI");
    expect(output).toContain("COPILOT_CLI_PATH");
    expect(output).toContain("@github/copilot/npm-loader.js");
  });

  it("doctor flags the bogus @github/index.js CLI path", async () => {
    const output = await runDoctor(["--offline"], {
      resolveCliPath: () => "/proj/node_modules/@github/index.js",
    });

    expect(output).toContain("COPILOT_CLI_PATH");
    expect(output).toContain("@github/copilot/npm-loader.js");
  });

  it("doctor respects an existing COPILOT_CLI_PATH override", async () => {
    process.env["COPILOT_CLI_PATH"] = "/custom/copilot/entry.js";

    const output = await runDoctor(["--offline"], { resolveCliPath: () => undefined });

    expect(output).toContain("COPILOT_CLI_PATH override");
    expect(output).not.toContain("known Windows path-resolution issue");
  });

  it("doctor Copilot CLI remediation does not leak the home path or username", async () => {
    const output = await runDoctor(["--offline"], { resolveCliPath: () => undefined });
    const remediationLine =
      output.split("\n").find((line) => line.includes("COPILOT_CLI_PATH")) ?? "";

    expect(remediationLine).toContain("npm-loader.js");
    expect(remediationLine).not.toContain(os.homedir());
    expect(remediationLine).not.toContain(os.userInfo().username);
  });

  it("doctor lists each known provider with availability sourced from the registry", async () => {
    const output = await runDoctor(["--offline"]);

    expect(output).toContain("Providers");

    const lineFor = (id: string): string =>
      output.split("\n").find((line) => line.trimStart().startsWith(`${id} `)) ?? "";

    const copilotLine = lineFor("copilot");
    expect(copilotLine).toContain("available");
    expect(copilotLine).not.toContain("not yet");

    const mockLine = lineFor("mock");
    expect(mockLine).toContain("available");
    expect(mockLine).not.toContain("not yet");

    const openaiLine = lineFor("openai");
    expect(openaiLine).toContain("not yet available");
    expect(openaiLine).toContain("coming soon");

    const anthropicLine = lineFor("anthropic");
    expect(anthropicLine).toContain("not yet available");
    expect(anthropicLine).toContain("coming soon");
  });

  it("doctor provider section never prints an API key value", async () => {
    const original = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "sk-LEAKED-SECRET-doctor-value";
    try {
      const output = await runDoctor(["--offline"]);

      expect(output).toContain("Providers");
      expect(output).not.toContain("sk-LEAKED-SECRET-doctor-value");
    } finally {
      if (original === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = original;
    }
  });

  it("doctor provider section respects ASCII mode (NO_COLOR)", async () => {
    const original = process.env["NO_COLOR"];
    process.env["NO_COLOR"] = "1";
    try {
      const output = await runDoctor(["--offline"]);

      expect(output).toContain("[i] Providers");

      const providerLines = output
        .split("\n")
        .filter((line) => /^\s+(copilot|mock|openai|anthropic) /.test(line));
      expect(providerLines.length).toBeGreaterThanOrEqual(4);
      for (const line of providerLines) {
        expect(line).not.toContain("\u2014");
      }
    } finally {
      if (original === undefined) delete process.env["NO_COLOR"];
      else process.env["NO_COLOR"] = original;
    }
  });
});

describe("checkNodeVersion", () => {
  it("fails for Node older than 24", async () => {
    const result = await checkNodeVersion("23.5.0");
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("24 or newer");
  });

  it("passes for Node 24 and newer", async () => {
    const result = await checkNodeVersion("24.0.0");
    expect(result.status).toBe("pass");
    expect(result.detail).toContain(">= 24 required");
  });
});
