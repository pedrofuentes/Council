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

  it("doctor --online with successful probe shows session creation success", async () => {
    const onlineProbe = vi.fn(async (model: string) => ({
      ok: true,
      detail: `probe ok for ${model}`,
    }));

    const output = await runDoctor(["--online"], { onlineProbe });

    expect(onlineProbe).toHaveBeenCalledTimes(1);
    expect(onlineProbe).toHaveBeenCalledWith("claude-sonnet-4-20250514");
    expect(output).toContain(
      "Default model (claude-sonnet-4-20250514) session created successfully",
    );
  });

  it("doctor --online with failed probe shows error", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: false, detail: "authentication required" }));

    const output = await runDoctor(["--online"], { onlineProbe });

    expect(onlineProbe).toHaveBeenCalledTimes(1);
    expect(output).toContain("Default model (claude-sonnet-4-20250514)");
    expect(output).toContain("authentication required");
    expect(output).toContain("Try changing defaults.model in");
  });

  it("doctor without --online skips model probe", async () => {
    const onlineProbe = vi.fn(async () => ({ ok: true, detail: "should not run" }));

    const output = await runDoctor([], { onlineProbe });

    expect(onlineProbe).not.toHaveBeenCalled();
    expect(output).toContain("Council Doctor");
    expect(output).not.toContain("Default model (");
  });

  it("doctor --models lists known models", async () => {
    const output = await runDoctor(["--models"]);

    expect(output).toContain("Known models:");
    expect(output).toContain(
      "Anthropic: claude-haiku-4.5, claude-sonnet-4.5, claude-sonnet-4.6, claude-opus-4.5, claude-opus-4.6, claude-opus-4.7",
    );
    expect(output).toContain(
      "OpenAI   : gpt-4.1, gpt-5-mini, gpt-5.2, gpt-5.4, gpt-5.5, gpt-5.4-mini",
    );
    expect(output).not.toContain("Google");
    expect(output).toContain("Use --online to verify your default model is accessible");
  });

  it("doctor help describes the online probe as a default-model check", () => {
    const help = buildDoctorCommandWithDeps({}).helpInformation();

    expect(help).toContain("Probe Copilot for default model availability (requires auth)");
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
