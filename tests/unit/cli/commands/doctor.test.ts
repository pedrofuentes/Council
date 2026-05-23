/**
 * Tests for `council doctor`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDoctorCommand } from "../../../../src/cli/commands/doctor.js";
import type { Writer } from "../../../../src/cli/commands/writer.js";

interface DoctorDepsLike {
  readonly write?: Writer;
  readonly onlineProbe?: (model: string) => Promise<{ ok: boolean; detail: string }>;
  readonly discoverModels?: () => Promise<{
    models: readonly string[];
    source: "live" | "static";
  }>;
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

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-doctor-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
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

  it("doctor --offline skips model probe", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: true, detail: "should not run" }));

    const output = await runDoctor(["--offline"], { onlineProbe });

    expect(onlineProbe).not.toHaveBeenCalled();
    expect(output).toContain("Council Doctor");
    expect(output).not.toContain("Default model (");
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

  it("doctor --models sorts scrambled discovered models before grouping", async () => {
    const discoverModels = vi.fn(async () => ({
      models: ["gpt-5.4", "claude-sonnet-4.5", "gpt-5.4-mini", "claude-haiku-4.5"],
      source: "live" as const,
    }));

    const output = await runDoctor(["--models", "--offline"], { discoverModels });

    expect(output).toContain("Available models:");
    expect(output).toContain("Anthropic: claude-haiku-4.5, claude-sonnet-4.5");
    expect(output).toContain("OpenAI   : gpt-5.4, gpt-5.4-mini");
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("doctor --models filters invalid discovered model IDs after sanitization", async () => {
    const discoverModels = vi.fn(async () => ({
      models: ["claude-\u001b[31msonnet-4.6\u001b[0m", "gpt-5.4\nmini", "gpt-5.4;rm -rf /"],
      source: "live" as const,
    }));

    const output = await runDoctor(["--models", "--offline"], { discoverModels });

    expect(output).toContain("Anthropic: claude-sonnet-4.6");
    expect(output).not.toContain("OpenAI   :");
    expect(output).not.toContain("gpt-5.4 mini");
    expect(output).not.toContain("gpt-5.4;rm -rf /");
    expect(output).not.toContain("\u001b[31m");
    expect(output).not.toContain("gpt-5.4\nmini");
  });

  it("doctor excludes shell metacharacters from remediation alternatives and fix commands", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: false, detail: "model not found" }));
    const discoverModels = vi.fn(async () => ({
      models: ["claude-sonnet-4.5", "gpt-5.4;rm -rf /", "gpt-\u001b[31m5.4\u001b[0m"],
      source: "live" as const,
    }));

    const output = await runDoctor([], { onlineProbe, discoverModels });

    expect(output).toContain("Available alternatives:");
    expect(output).toContain("     gpt-5.4");
    expect(output).toContain("Fix: council config set defaults.model gpt-5.4");
    expect(output).not.toContain("gpt-5.4;rm -rf /");
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
    const output = await runDoctor([]);

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

    const output = await runDoctor([]);

    expect(output).toContain("Engine: mock");
    expect(output).toContain("Rounds: 7");
  });

  it("doctor shows warning when config is invalid", async () => {
    await fs.mkdir(testHome, { recursive: true });
    await fs.writeFile(path.join(testHome, "config.yaml"), "{{invalid yaml", "utf-8");

    const output = await runDoctor([]);

    expect(output).toContain("Could not load configuration");
  });
});
