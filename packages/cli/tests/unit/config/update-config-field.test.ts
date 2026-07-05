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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

  it("preserves the original config when the temp write fails mid-update", async () => {
    await fs.mkdir(testHome, { recursive: true });
    const original = "defaults:\n  model: claude-sonnet-4.5\n  engine: mock\n";
    await fs.writeFile(configPath, original, "utf-8");

    const writeError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    let tempOpenPath: unknown;

    // The hardened writer creates its temp file with an exclusive `wx` open and
    // writes THROUGH that handle (never via a bare path). Force the handle's
    // write to fail (disk full) and assert the original config is left intact.
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const [openPath, flags] = args;
      const handle = await actualFs.open(...args);
      if (isUniqueTempPath(openPath, configPath) && String(flags).includes("w")) {
        tempOpenPath = openPath;
        vi.spyOn(handle, "writeFile").mockRejectedValue(writeError);
      }
      return handle;
    });

    await expect(updateConfigField("defaults.model", "gpt-5")).rejects.toMatchObject({
      code: "ENOSPC",
    });
    await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(original);
    expect(isUniqueTempPath(tempOpenPath, configPath)).toBe(true);
  });

  it("does not follow a symlink pre-planted at the temp path (no arbitrary write)", async () => {
    await fs.mkdir(testHome, { recursive: true });
    const original = "defaults:\n  model: claude-sonnet-4.5\n  engine: mock\n";
    await fs.writeFile(configPath, original, "utf-8");

    // A file an attacker on a shared temp dir wants clobbered via the config write.
    const victimPath = path.join(testHome, "victim.txt");
    const victimContent = "DO-NOT-CLOBBER\n";
    await fs.writeFile(victimPath, victimContent, "utf-8");

    // Simulate an attacker pre-planting a symlink at the EXACT temp path the
    // writer is about to use: intercept the first temp-path create (whether the
    // writer uses a bare `fs.writeFile` or an exclusive `fs.open`) and drop a
    // symlink -> victim there, then let the real operation run against it. A
    // symlink-following write (the pre-#1925 behavior) clobbers the victim; an
    // exclusive `wx` open fails with EEXIST and the writer must recover.
    let planted = false;
    const plantSymlinkAt = async (target: unknown): Promise<void> => {
      if (!planted && isUniqueTempPath(target, configPath)) {
        planted = true;
        await actualFs.symlink(victimPath, target);
      }
    };
    vi.mocked(fs.writeFile).mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      await plantSymlinkAt(args[0]);
      return actualFs.writeFile(...args);
    });
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const [openPath, flags] = args;
      if (String(flags).includes("w")) {
        await plantSymlinkAt(openPath);
      }
      return actualFs.open(...args);
    });

    await updateConfigField("defaults.model", "gpt-5");

    // The victim must be untouched: the write must not have followed the symlink.
    await expect(fs.readFile(victimPath, "utf-8")).resolves.toBe(victimContent);
    // ...and the legitimate update still lands in config.yaml (the writer
    // recovered to a fresh, unguessable temp name instead of following it).
    const updated = await loadConfig();
    expect(updated.defaults.model).toBe("gpt-5");
  });

  it("uses a cryptographically-random temp file name, not a predictable pid/timestamp", async () => {
    await fs.mkdir(testHome, { recursive: true });
    await fs.writeFile(
      configPath,
      "defaults:\n  model: claude-sonnet-4.5\n  engine: mock\n",
      "utf-8",
    );

    const tempPaths: string[] = [];
    const record = (target: unknown): void => {
      if (isUniqueTempPath(target, configPath)) tempPaths.push(target);
    };
    vi.mocked(fs.writeFile).mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      record(args[0]);
      return actualFs.writeFile(...args);
    });
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const [openPath, flags] = args;
      if (String(flags).includes("w")) record(openPath);
      return actualFs.open(...args);
    });

    await updateConfigField("defaults.model", "gpt-5");

    expect(tempPaths).toHaveLength(1);
    // Between the config path and the `.tmp` suffix there must be a long run of
    // hex entropy (>= 8 random bytes = 16 hex chars), defeating pid+timestamp
    // guessing. A predictable `<pid>.<Date.now()>` suffix will not match.
    expect(tempPaths[0]).toMatch(/\.[0-9a-f]{16,}\.tmp$/);
  });

  it("removes the temp file and preserves the config when rename fails", async () => {
    await fs.mkdir(testHome, { recursive: true });
    const original = "defaults:\n  model: claude-sonnet-4.5\n  engine: mock\n";
    await fs.writeFile(configPath, original, "utf-8");

    const renameError = new Error("rename failed");
    let tmpPath: string | undefined;
    const renameSpy = vi
      .mocked(fs.rename)
      .mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
        const [fromPath, toPath] = args;
        if (toPath === configPath && isUniqueTempPath(fromPath, configPath)) {
          tmpPath = fromPath;
          throw renameError;
        }
        return actualFs.rename(...args);
      });

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
