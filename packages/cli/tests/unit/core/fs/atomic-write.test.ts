/**
 * Tests for the symlink/TOCTOU-safe atomic file writer (CWE-59 hardening, #2206).
 *
 * `writeFileAtomicSafe` is the shared helper extracted so the update-notifier
 * cache writer and the telemetry counter writer stop using a PREDICTABLE temp
 * name (`<path>.<pid>.tmp`) plus a symlink-following `writeFile`. It mirrors the
 * config loader's `writeConfigAtomically` (#1925):
 *   - the temp file name embeds cryptographically-random bytes (unguessable, so
 *     an attacker on a shared directory cannot pre-plant an entry at it),
 *   - the temp file is opened with `"wx"` (O_CREAT|O_EXCL|O_WRONLY) so a
 *     pre-existing entry — including a planted symlink — fails with EEXIST
 *     instead of being followed,
 *   - content is written THROUGH that exclusive handle (the path is never
 *     re-opened, closing the write-time TOCTOU window), then renamed into place,
 *   - EEXIST triggers a bounded retry with a fresh random name, and a failed
 *     rename unlinks the temp file so a botched write never leaks it.
 *
 * Hermetic: every test writes inside a per-test temp directory; `node:fs/promises`
 * is mocked so a symlink can be planted at the exact temp path the writer chooses
 * and so `open`/`rename` failures can be injected deterministically.
 *
 * RED at this commit: src/core/fs/atomic-write.ts does not exist yet.
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
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
  };
});

import { writeFileAtomicSafe } from "../../../../src/core/fs/atomic-write.js";

let actualFs: typeof fs;
let dir: string;
let targetPath: string;

function isUniqueTempPath(target: unknown, base: string): target is string {
  return typeof target === "string" && target.startsWith(`${base}.`) && target.endsWith(".tmp");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await actualFs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  actualFs = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockImplementation(actualFs.open);
  vi.mocked(fs.rename).mockImplementation(actualFs.rename);
  vi.mocked(fs.unlink).mockImplementation(actualFs.unlink);

  dir = await actualFs.mkdtemp(path.join(os.tmpdir(), "council-atomic-write-"));
  targetPath = path.join(dir, "data.json");
});

afterEach(async () => {
  vi.clearAllMocks();
  await actualFs.rm(dir, { recursive: true, force: true });
});

describe("writeFileAtomicSafe", () => {
  it("writes the data and creates the parent directory when missing", async () => {
    const nested = path.join(dir, "deep", "nested", "data.json");

    await writeFileAtomicSafe(nested, '{"ok":true}');

    await expect(actualFs.readFile(nested, "utf-8")).resolves.toBe('{"ok":true}');
  });

  it("uses a cryptographically-random temp file name, not a predictable pid/timestamp", async () => {
    const tempPaths: string[] = [];
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const [openPath, flags] = args;
      if (isUniqueTempPath(openPath, targetPath) && String(flags).includes("w")) {
        tempPaths.push(openPath);
      }
      return actualFs.open(...args);
    });

    await writeFileAtomicSafe(targetPath, "payload");

    expect(tempPaths).toHaveLength(1);
    // At least 8 random bytes = 16 hex chars between the base path and `.tmp`.
    // A predictable `<pid>.tmp` (decimal, short) will not match.
    expect(tempPaths[0]).toMatch(/\.[0-9a-f]{16,}\.tmp$/);
  });

  it("does not follow a symlink pre-planted at the temp path (no arbitrary write)", async () => {
    const victimPath = path.join(dir, "victim.txt");
    const victimContent = "DO-NOT-CLOBBER\n";
    await actualFs.writeFile(victimPath, victimContent, "utf-8");

    // Plant a symlink -> victim at the EXACT temp path the writer is about to
    // create, then let the real open run. A symlink-following write clobbers the
    // victim; an exclusive `wx` open fails with EEXIST and the writer recovers.
    let planted = false;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const [openPath, flags] = args;
      if (!planted && isUniqueTempPath(openPath, targetPath) && String(flags).includes("w")) {
        planted = true;
        await actualFs.symlink(victimPath, openPath);
      }
      return actualFs.open(...args);
    });

    await writeFileAtomicSafe(targetPath, '{"safe":true}');

    // The victim must be untouched: the write must not have followed the symlink.
    await expect(actualFs.readFile(victimPath, "utf-8")).resolves.toBe(victimContent);
    // ...and the legitimate write still lands at the target (fresh random name).
    await expect(actualFs.readFile(targetPath, "utf-8")).resolves.toBe('{"safe":true}');
    expect(planted).toBe(true);
  });

  it("applies the requested file mode to the created file", async () => {
    await writeFileAtomicSafe(targetPath, "private", { mode: 0o600 });

    const stat = await actualFs.stat(targetPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("removes the temp file and rethrows when the rename fails", async () => {
    const renameError = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    let tempPath: string | undefined;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const [openPath, flags] = args;
      if (isUniqueTempPath(openPath, targetPath) && String(flags).includes("w")) {
        tempPath = openPath;
      }
      return actualFs.open(...args);
    });
    vi.mocked(fs.rename).mockRejectedValue(renameError);

    await expect(writeFileAtomicSafe(targetPath, "payload")).rejects.toMatchObject({
      code: "EXDEV",
    });

    expect(tempPath).toBeDefined();
    expect(await pathExists(tempPath as string)).toBe(false);
    expect(await pathExists(targetPath)).toBe(false);
  });

  it("retries with a fresh random name when the temp path already exists (EEXIST)", async () => {
    const eexist = Object.assign(new Error("exists"), { code: "EEXIST" });
    let firstOpen = true;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const [openPath, flags] = args;
      if (firstOpen && isUniqueTempPath(openPath, targetPath) && String(flags).includes("w")) {
        firstOpen = false;
        throw eexist;
      }
      return actualFs.open(...args);
    });

    await writeFileAtomicSafe(targetPath, "recovered");

    await expect(actualFs.readFile(targetPath, "utf-8")).resolves.toBe("recovered");
    expect(vi.mocked(fs.open).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("rethrows a non-EEXIST error from the exclusive open", async () => {
    const permError = Object.assign(new Error("denied"), { code: "EACCES" });
    vi.mocked(fs.open).mockRejectedValue(permError);

    await expect(writeFileAtomicSafe(targetPath, "payload")).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("throws after exhausting attempts when every exclusive open hits EEXIST", async () => {
    const eexist = Object.assign(new Error("exists"), { code: "EEXIST" });
    vi.mocked(fs.open).mockRejectedValue(eexist);

    await expect(writeFileAtomicSafe(targetPath, "payload")).rejects.toThrow(
      /exclusive temporary file/i,
    );
  });
});
