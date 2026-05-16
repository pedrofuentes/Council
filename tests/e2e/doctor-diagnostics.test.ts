import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { buildDoctorCommand } from "../../src/cli/commands/doctor.js";

import { captureOutput, cleanupE2EContext, createE2EContext, type E2EContext } from "./helpers.js";

describe("doctor diagnostics E2E", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await createE2EContext();
  });

  afterEach(async () => {
    await cleanupE2EContext(ctx);
  });

  it("doctor basic checks pass", async () => {
    const output = captureOutput();
    const cmd = buildDoctorCommand({ write: output.write });

    await cmd.parseAsync(["node", "council-doctor"]);

    const stdout = output.stdout();
    expect(stdout).toContain("Council Doctor");
    expect(stdout).toContain("Node.js version");
    expect(stdout).toContain("Council home");
    expect(stdout).toContain("SQLite (libsql)");
    expect(stdout).toContain("All checks passed");
  });

  it("doctor with missing config auto-creates", async () => {
    const configPath = path.join(ctx.testHome, "config.yaml");
    const configExists = async (): Promise<boolean> => {
      try {
        await fs.access(configPath);
        return true;
      } catch {
        return false;
      }
    };

    expect(await configExists()).toBe(false);

    const output = captureOutput();
    const cmd = buildDoctorCommand({ write: output.write });

    await cmd.parseAsync(["node", "council-doctor"]);

    const stdout = output.stdout();
    expect(stdout).toContain("Council home");
    expect(stdout).toContain(ctx.testHome);
  });

  it("doctor --models lists known models", async () => {
    const output = captureOutput();
    const cmd = buildDoctorCommand({ write: output.write });

    await cmd.parseAsync(["node", "council-doctor", "--models"]);

    const stdout = output.stdout();
    expect(stdout).toContain("Known models:");
    expect(stdout).toContain("claude-");
    expect(stdout).toContain("gpt-");
    expect(stdout).toContain("gemini-");
    expect(stdout).toContain("Availability depends on your Copilot tier");
  });

  it("doctor --online with mocked probe", async () => {
    const output = captureOutput();
    const cmd = buildDoctorCommand({
      write: output.write,
      onlineProbe: async () => ({ ok: true, detail: "OK" }),
    });

    await cmd.parseAsync(["node", "council-doctor", "--online"]);

    const stdout = output.stdout();
    expect(stdout).toContain("Default model access");
    expect(stdout).toContain("✅");
    expect(stdout).toContain("All checks passed");
  });

  it("doctor --online with failing probe", async () => {
    const output = captureOutput();
    const cmd = buildDoctorCommand({
      write: output.write,
      onlineProbe: async () => ({ ok: false, detail: "Auth failed" }),
    });

    try {
      await cmd.parseAsync(["node", "council-doctor", "--online"]);
      expect.fail("Expected doctor to throw when checks fail");
    } catch {
      const stdout = output.stdout();
      expect(stdout).toContain("Default model access");
      expect(stdout).toContain("❌");
      expect(stdout).toContain("Auth failed");
      expect(stdout).toContain("Some checks failed");
    }
  });
});
