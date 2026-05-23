/**
 * Tests for updateConfigField().
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
  };
});

import { loadConfig, updateConfigField } from "../../../src/config/index.js";

describe("updateConfigField", () => {
  let actualFs: typeof import("node:fs/promises");
  let testHome: string;
  let configPath: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  beforeEach(async () => {
    actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.writeFile).mockImplementation(actualFs.writeFile);
    vi.mocked(fs.rename).mockImplementation(actualFs.rename);
    vi.mocked(fs.unlink).mockImplementation(actualFs.unlink);

    testHome = await fs.mkdtemp(path.join(process.cwd(), ".tmp-update-config-field-"));
    configPath = path.join(testHome, "config.yaml");
    process.env["COUNCIL_HOME"] = testHome;
  });

  afterEach(async () => {
    vi.clearAllMocks();
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

  it("preserves the original config when a write fails mid-update", async () => {
    await fs.mkdir(testHome, { recursive: true });
    const original = "defaults:\n  model: claude-sonnet-4.5\n  engine: mock\n";
    const tmpPath = `${configPath}.tmp`;
    await fs.writeFile(configPath, original, "utf-8");

    const writeError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const writeFileSpy = vi.mocked(fs.writeFile).mockImplementation(
      async (...args: Parameters<typeof fs.writeFile>) => {
        const [filePath, data, options] = args;
        const text = typeof data === "string" ? data : data.toString();
        await actualFs.writeFile(filePath, `${text.slice(0, 12)}\n`, options);
        throw writeError;
      },
    );

    await expect(updateConfigField("defaults.model", "gpt-5")).rejects.toMatchObject({
      code: "ENOSPC",
    });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(original);
    expect(writeFileSpy).toHaveBeenCalledWith(tmpPath, expect.any(String), "utf-8");
  });

  it("removes the temp file and preserves the config when rename fails", async () => {
    await fs.mkdir(testHome, { recursive: true });
    const original = "defaults:\n  model: claude-sonnet-4.5\n  engine: mock\n";
    const tmpPath = `${configPath}.tmp`;
    await fs.writeFile(configPath, original, "utf-8");

    const renameError = new Error("rename failed");
    const renameSpy = vi.mocked(fs.rename).mockImplementation(
      async (...args: Parameters<typeof fs.rename>) => {
        const [fromPath, toPath] = args;
        if (fromPath === tmpPath && toPath === configPath) {
          throw renameError;
        }
        return Promise.resolve();
      },
    );

    await expect(updateConfigField("defaults.model", "gpt-5")).rejects.toThrow("rename failed");
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(original);
    await expect(fs.access(tmpPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(renameSpy).toHaveBeenCalledWith(tmpPath, configPath);
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
