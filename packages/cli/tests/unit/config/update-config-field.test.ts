/**
 * Tests for updateConfigField().
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
  };
});

import { loadConfig, updateConfigField } from "../../../src/config/index.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isUniqueTempPath(filePath: unknown, expectedConfigPath: string): filePath is string {
  return (
    typeof filePath === "string" &&
    filePath.startsWith(`${expectedConfigPath}.`) &&
    filePath.endsWith(".tmp")
  );
}

describe("updateConfigField", () => {
  let actualFs: typeof fs;
  let testHome: string;
  let configPath: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  beforeEach(async () => {
    actualFs = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(actualFs.open);
    vi.mocked(fs.writeFile).mockImplementation(actualFs.writeFile);
    vi.mocked(fs.rename).mockImplementation(actualFs.rename);
    vi.mocked(fs.unlink).mockImplementation(actualFs.unlink);

    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-update-config-field-"));
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

  it("does not lose updates when concurrent writers modify different fields", async () => {
    await fs.mkdir(testHome, { recursive: true });
    await fs.writeFile(
      configPath,
      "defaults:\n  model: claude-sonnet-4.5\n  engine: mock\n  maxRounds: 4\n",
      "utf-8",
    );

    let releaseFirstRename!: () => void;
    const allowFirstRename = new Promise<void>((resolve) => {
      releaseFirstRename = resolve;
    });
    let notifyFirstRenameStarted!: () => void;
    const firstRenameStarted = new Promise<void>((resolve) => {
      notifyFirstRenameStarted = resolve;
    });
    let didHoldFirstRename = false;

    vi.mocked(fs.rename).mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      const [fromPath, toPath] = args;
      if (!didHoldFirstRename && toPath === configPath && isUniqueTempPath(fromPath, configPath)) {
        didHoldFirstRename = true;
        notifyFirstRenameStarted();
        await allowFirstRename;
      }
      return actualFs.rename(...args);
    });

    const firstUpdate = updateConfigField("defaults.model", "gpt-5");
    await firstRenameStarted;
    const secondUpdate = updateConfigField("defaults.maxRounds", 8);
    await sleep(200);
    releaseFirstRename();

    await expect(Promise.all([firstUpdate, secondUpdate])).resolves.toBeDefined();

    const config = await loadConfig();
    expect(config.defaults.model).toBe("gpt-5");
    expect(config.defaults.maxRounds).toBe(8);
  });

  it("waits for an existing lock and succeeds after it is released", async () => {
    await fs.mkdir(testHome, { recursive: true });
    const original = "defaults:\n  model: claude-sonnet-4.5\n  engine: mock\n";
    const lockPath = `${configPath}.lock`;
    await fs.writeFile(configPath, original, "utf-8");
    await fs.writeFile(lockPath, "locked", "utf-8");

    let settled = false;
    const updatePromise = updateConfigField("defaults.model", "gpt-5").finally(() => {
      settled = true;
    });

    await sleep(200);
    expect(settled).toBe(false);
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(original);

    await fs.unlink(lockPath);
    await expect(updatePromise).resolves.toBeUndefined();

    const config = await loadConfig();
    expect(config.defaults.model).toBe("gpt-5");
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

    const tempWriteCall = writeFileSpy.mock.calls.find(([filePath]) =>
      isUniqueTempPath(filePath, configPath),
    );

    expect(tempWriteCall).toBeDefined();
    const [tmpPath, writtenData, encoding] = tempWriteCall ?? [];
    expect(isUniqueTempPath(tmpPath, configPath)).toBe(true);
    expect(writtenData).toEqual(expect.any(String));
    expect(encoding).toBe("utf-8");
  });

  it("removes the temp file and preserves the config when rename fails", async () => {
    await fs.mkdir(testHome, { recursive: true });
    const original = "defaults:\n  model: claude-sonnet-4.5\n  engine: mock\n";
    await fs.writeFile(configPath, original, "utf-8");

    const renameError = new Error("rename failed");
    let tmpPath: string | undefined;
    const renameSpy = vi.mocked(fs.rename).mockImplementation(
      async (...args: Parameters<typeof fs.rename>) => {
        const [fromPath, toPath] = args;
        if (toPath === configPath && isUniqueTempPath(fromPath, configPath)) {
          tmpPath = fromPath;
          throw renameError;
        }
        return actualFs.rename(...args);
      },
    );

    await expect(updateConfigField("defaults.model", "gpt-5")).rejects.toThrow("rename failed");
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(original);
    expect(tmpPath).toBeDefined();
    await expect(fs.access(tmpPath as string)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("wraps non-ENOENT read errors with the config file path", async () => {
    // Make config.yaml a directory so readFile fails with EISDIR (non-ENOENT).
    await fs.mkdir(configPath, { recursive: true });

    await expect(updateConfigField("defaults.model", "gpt-5")).rejects.toThrow(
      new RegExp(`Failed to read Council config \\(${escapeRegExp(configPath)}\\): EISDIR`),
    );
  });

  it("retries on EPERM from fs.open (Windows NTFS lock contention)", async () => {
    await fs.mkdir(testHome, { recursive: true });
    await fs.writeFile(
      configPath,
      "defaults:\n  model: claude-sonnet-4.5\n  engine: mock\n",
      "utf-8",
    );

    let exclusiveOpenCount = 0;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const flags = String(args[1]);
      if (flags.includes("x")) {
        exclusiveOpenCount += 1;
        if (exclusiveOpenCount === 1) {
          const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
      }
      return actualFs.open(...args);
    });

    await updateConfigField("defaults.model", "gpt-5");

    const config = await loadConfig();
    expect(config.defaults.model).toBe("gpt-5");
    expect(exclusiveOpenCount).toBeGreaterThan(1);
  });
});
