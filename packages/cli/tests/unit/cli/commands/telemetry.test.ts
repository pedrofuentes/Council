/**
 * Tests for `council telemetry`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTelemetryCommand } from "../../../../src/cli/commands/telemetry.js";
import type { Writer } from "../../../../src/cli/commands/writer.js";

async function runTelemetry(args: readonly string[]): Promise<string> {
  let captured = "";
  const write: Writer = (chunk: string) => {
    captured += chunk;
  };
  const cmd = buildTelemetryCommand({ write });
  cmd.exitOverride();
  await cmd.parseAsync(["node", "council-telemetry", ...args]).catch(() => undefined);
  return captured;
}

describe("buildTelemetryCommand", () => {
  let testHome: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-telemetry-test-"));
    originalHome = process.env["COUNCIL_HOME"];
    process.env["COUNCIL_HOME"] = testHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
    else process.env["COUNCIL_HOME"] = originalHome;
    await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  describe("status", () => {
    it("shows disabled by default", async () => {
      const output = await runTelemetry(["status"]);
      expect(output).toContain("disabled");
    });

    it("shows enabled when telemetry is on", async () => {
      const configPath = path.join(testHome, "config.yaml");
      await fs.writeFile(
        configPath,
        "telemetry:\n  enabled: true\n",
        "utf-8",
      );
      const output = await runTelemetry(["status"]);
      expect(output).toContain("enabled");
    });
  });

  describe("enable", () => {
    it("persists telemetry.enabled to config", async () => {
      const output = await runTelemetry(["enable"]);
      expect(output).toContain("enabled");

      const configPath = path.join(testHome, "config.yaml");
      const configContent = await fs.readFile(configPath, "utf-8");
      expect(configContent).toContain("enabled: true");
    });
  });

  describe("disable", () => {
    it("persists telemetry.enabled=false to config", async () => {
      const output = await runTelemetry(["disable"]);
      expect(output).toContain("disabled");

      const configPath = path.join(testHome, "config.yaml");
      const configContent = await fs.readFile(configPath, "utf-8");
      expect(configContent).toContain("enabled: false");
    });
  });

  describe("explain", () => {
    it("summarizes telemetry policy", async () => {
      const output = await runTelemetry(["explain"]);
      expect(output.toLowerCase()).toContain("opt-in");
      expect(output.toLowerCase()).toContain("content-free");
      expect(output).toContain("command");
      expect(output).toContain("version");
    });

    it("mentions allowed fields", async () => {
      const output = await runTelemetry(["explain"]);
      expect(output.toLowerCase()).toContain("allowed");
    });

    it("mentions forbidden fields", async () => {
      const output = await runTelemetry(["explain"]);
      expect(output.toLowerCase()).toContain("forbidden");
    });

    it("points to privacy documentation", async () => {
      const output = await runTelemetry(["explain"]);
      expect(output).toMatch(/PRIVACY\.md|docs\/TELEMETRY\.md/i);
    });
  });
});
