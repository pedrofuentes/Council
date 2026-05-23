/**
 * Tests for updateConfigField().
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, updateConfigField } from "../../../src/config/index.js";

describe("updateConfigField", () => {
  let testHome: string;
  let configPath: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(process.cwd(), ".tmp-update-config-field-"));
    configPath = path.join(testHome, "config.yaml");
    process.env["COUNCIL_HOME"] = testHome;
  });

  afterEach(async () => {
    if (originalCouncilHome === undefined) {
      delete process.env["COUNCIL_HOME"];
    } else {
      process.env["COUNCIL_HOME"] = originalCouncilHome;
    }
    await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("creates config.yaml when missing and updates the requested field", async () => {
    await updateConfigField("defaults.model", "gpt-5");

    const config = await loadConfig();
    expect(config.defaults.model).toBe("gpt-5");
    const written = await fs.readFile(path.join(testHome, "config.yaml"), "utf-8");
    expect(written).toContain("model: gpt-5");
  });

  it("preserves existing YAML comments while updating a field", async () => {
    await fs.mkdir(testHome, { recursive: true });
    await fs.writeFile(
      configPath,
      "# Keep this comment\ndefaults:\n  # Keep this too\n  model: claude-sonnet-4.5\n  engine: mock\n",
      "utf-8",
    );

    await updateConfigField("defaults.model", "claude-opus-4.1");

    const updated = await fs.readFile(configPath, "utf-8");
    expect(updated).toContain("# Keep this comment");
    expect(updated).toContain("# Keep this too");
    expect(updated).toContain("model: claude-opus-4.1");
    expect(updated).toContain("engine: mock");
  });

  it("does not modify the file when validation fails", async () => {
    await fs.mkdir(testHome, { recursive: true });
    const original = "defaults:\n  maxRounds: 4\n";
    await fs.writeFile(configPath, original, "utf-8");

    await expect(updateConfigField("defaults.maxRounds", 999)).rejects.toThrow(/maxRounds/i);
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(original);
  });

  it("throws and preserves the file when the YAML root is a scalar", async () => {
    await fs.mkdir(testHome, { recursive: true });
    const original = '"just a string"\n';
    await fs.writeFile(configPath, original, "utf-8");

    await expect(updateConfigField("defaults.model", "gpt-5")).rejects.toThrow(
      /invalid root structure/i,
    );
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(original);
  });

  it("throws and preserves the file when the YAML root is an array", async () => {
    await fs.mkdir(testHome, { recursive: true });
    const original = "- item1\n- item2\n";
    await fs.writeFile(configPath, original, "utf-8");

    await expect(updateConfigField("defaults.model", "gpt-5")).rejects.toThrow(
      /invalid root structure/i,
    );
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(original);
  });

  it("throws and preserves the file when the YAML is malformed", async () => {
    await fs.mkdir(testHome, { recursive: true });
    const original = ": invalid: yaml: [";
    await fs.writeFile(configPath, original, "utf-8");

    await expect(updateConfigField("defaults.model", "gpt-5")).rejects.toThrow(
      /Failed to parse Council config/i,
    );
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(original);
  });
});
