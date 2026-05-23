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

  it("doctor basic checks pass with --offline", async () => {
    const output = captureOutput();
    const cmd = buildDoctorCommand({ write: output.write });

    await cmd.parseAsync(["node", "council-doctor", "--offline"]);

    const stdout = output.stdout();
    expect(stdout).toContain("Council Doctor");
    expect(stdout).toContain("Node.js version");
    expect(stdout).toContain("Council home");
    expect(stdout).toContain("SQLite (libsql)");
    expect(stdout).toContain("All checks passed");

    const unsafeCleanupCtx: E2EContext = {
      testHome: path.join(process.cwd(), ".should-not-delete-home"),
      testDataHome: path.join(process.cwd(), ".should-not-delete-data"),
      originalHome: process.env["COUNCIL_HOME"],
      originalDataHome: process.env["COUNCIL_DATA_HOME"],
    };

    await expect(cleanupE2EContext(unsafeCleanupCtx)).rejects.toThrow(
      /Refusing to delete non-temp path/,
    );
  });

  it("doctor ensures council home directory exists", async () => {
    // Remove the directory to verify doctor recreates it
    await fs.rm(ctx.testHome, { recursive: true, force: true });

    const homeExists = async (): Promise<boolean> => {
      try {
        await fs.access(ctx.testHome);
        return true;
      } catch {
        return false;
      }
    };

    expect(await homeExists()).toBe(false);

    const output = captureOutput();
    const cmd = buildDoctorCommand({
      write: output.write,
      onlineProbe: async () => ({ ok: true, detail: "OK" }),
    });

    await cmd.parseAsync(["node", "council-doctor", "--offline"]);

    const stdout = output.stdout();
    expect(stdout).toContain("Council home");
    expect(stdout).toContain(ctx.testHome);
    expect(await homeExists()).toBe(true);
  });

  it("doctor --models lists available models from live discovery", async () => {
    const output = captureOutput();
    const cmd = buildDoctorCommand({
      write: output.write,
      onlineProbe: async () => ({ ok: true, detail: "OK" }),
    });

    await cmd.parseAsync(["node", "council-doctor", "--models", "--offline"]);

    const stdout = output.stdout();
    expect(stdout).toContain("Available models:");
    expect(stdout).toContain("Anthropic:");
    expect(stdout).toContain("OpenAI   :");
    expect(stdout).toContain("claude-sonnet-4.5");
    expect(stdout).toContain("gpt-5.4");
    expect(stdout).toContain("Availability depends on your Copilot tier");
  });

  it("doctor runs online check by default with mocked probe", async () => {
    const output = captureOutput();
    const cmd = buildDoctorCommand({
      write: output.write,
      onlineProbe: async () => ({ ok: true, detail: "OK" }),
    });

    await cmd.parseAsync(["node", "council-doctor"]);

    const stdout = output.stdout();
    expect(stdout).toContain("Default model access");
    expect(stdout).toContain("✅");
    expect(stdout).toContain("All checks passed");
  });

  it("doctor with failing probe by default", async () => {
    const output = captureOutput();
    const cmd = buildDoctorCommand({
      write: output.write,
      onlineProbe: async () => ({ ok: false, detail: "Auth failed" }),
    });

    try {
      await cmd.parseAsync(["node", "council-doctor"]);
      expect.fail("Expected doctor to throw when checks fail");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('process.exit unexpectedly called with "1"');
      const stdout = output.stdout();
      expect(stdout).toContain("Default model access");
      expect(stdout).toContain("❌");
      expect(stdout).toContain("Auth failed");
      expect(stdout).toContain("Some checks failed");
    }
  });

  it("doctor --offline skips online check", async () => {
    const output = captureOutput();
    const cmd = buildDoctorCommand({
      write: output.write,
      onlineProbe: async () => {
        throw new Error("Should not be called");
      },
    });

    await cmd.parseAsync(["node", "council-doctor", "--offline"]);

    const stdout = output.stdout();
    expect(stdout).toContain("Council Doctor");
    expect(stdout).not.toContain("Default model access");
    expect(stdout).toContain("All checks passed");
  });
});
