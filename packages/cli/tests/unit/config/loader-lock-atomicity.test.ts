/**
 * Cross-process config-lock atomicity regressions (#1924, #1923).
 *
 * #1924 — acquireConfigLock creates the lock file with an exclusive open and
 * THEN writes owner metadata into it. If that metadata write fails (ENOSPC/EIO)
 * the lock file has already been created, so a naive implementation leaks an
 * unattributable orphan lock that wedges every future acquisition (it can never
 * be re-created with `wx`, and its missing owner metadata defers reaping to the
 * staleness window). A failing acquire must remove the file it just created
 * before propagating the error.
 *
 * #1923 — releaseConfigLock must only remove the EXACT lock file it created.
 * If a slow holder's lock was reaped and re-acquired by a successor, the
 * successor's lock must not be deleted out from under it, or two processes end
 * up believing they hold the lock (A-B-A). Ownership is proven by the lock
 * file's inode identity ({dev, ino}) captured at acquire: because the protocol
 * only ever creates a lock via an exclusive `wx` open on a FREE path, any
 * reap+recreate by a successor yields a DIFFERENT inode, so a changed inode at
 * the path means "not ours — leave it alone". These tests recreate the
 * successor's lock at a fresh inode (unlink + create) to model that hand-off
 * faithfully; an in-place overwrite would keep the original inode and so cannot
 * occur under the `wx`-only protocol.
 *
 * NOTE: the reaper's own decision→removal A-B-A window (once residual work) is
 * now closed by rename-to-claim + re-verify in reapIfStale, and release is
 * inode-verified; both are covered in loader-lock-inode-identity.test.ts. These
 * tests cover the identity-verified RELEASE and the #1924 orphan cleanup.
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
  };
});

import { updateConfigField, withConfigWriteLock } from "../../../src/config/index.js";

const BASE_CONFIG = "defaults:\n  model: claude-sonnet-4.5\n  engine: mock\n";

describe("acquireConfigLock orphan-lock cleanup (#1924)", () => {
  let actualFs: typeof fs;
  let testHome: string;
  let configPath: string;
  let lockPath: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  beforeEach(async () => {
    actualFs = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(actualFs.open);

    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-lock-orphan-"));
    configPath = path.join(testHome, "config.yaml");
    lockPath = `${configPath}.lock`;
    process.env["COUNCIL_HOME"] = testHome;
    await fs.writeFile(configPath, BASE_CONFIG, "utf-8");
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

  it("removes the just-created lock file and propagates the error when writing lock metadata fails", async () => {
    // The exclusive open genuinely creates the lock file on disk (reproducing
    // the leak precondition); only the subsequent metadata write is forced to
    // fail, mimicking ENOSPC/EIO after the file already exists.
    const writeError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const realHandle = await actualFs.open(...args);
      const [targetPath, flags] = args;
      if (
        typeof targetPath === "string" &&
        targetPath.endsWith(".lock") &&
        typeof flags === "string" &&
        flags.includes("x")
      ) {
        vi.spyOn(realHandle, "writeFile").mockRejectedValue(writeError);
      }
      return realHandle;
    });

    // The original I/O error must propagate unchanged...
    await expect(updateConfigField("defaults.model", "gpt-5")).rejects.toMatchObject({
      code: "ENOSPC",
    });

    // ...and the lock file it created must NOT survive as an orphan.
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the lock file in place (holding this owner's token) during a successful acquisition", async () => {
    // Inverse invariant: cleanup is strictly a failure-path action. A normal
    // acquire must leave the lock present and stamped with a real token for the
    // duration of the critical section.
    let tokenDuringCriticalSection: unknown;
    let lockPresentDuringCriticalSection = false;

    await withConfigWriteLock(async () => {
      const raw = await fs.readFile(lockPath, "utf-8");
      lockPresentDuringCriticalSection = true;
      tokenDuringCriticalSection = (JSON.parse(raw) as { token?: unknown }).token;
    });

    expect(lockPresentDuringCriticalSection).toBe(true);
    expect(typeof tokenDuringCriticalSection).toBe("string");
    expect((tokenDuringCriticalSection as string).length).toBeGreaterThan(0);
  });
});

describe("releaseConfigLock ownership verification (#1923)", () => {
  let testHome: string;
  let configPath: string;
  let lockPath: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  beforeEach(async () => {
    const actualFs = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(actualFs.open);

    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-lock-release-"));
    configPath = path.join(testHome, "config.yaml");
    lockPath = `${configPath}.lock`;
    process.env["COUNCIL_HOME"] = testHome;
    await fs.writeFile(configPath, BASE_CONFIG, "utf-8");
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

  it("does not delete a successor's lock that is mid-acquire (fresh inode, unflushed empty metadata)", async () => {
    // A successor reaped our lock and won a fresh lock race via `wx` (NEW inode)
    // but has not yet flushed its metadata, so the file reads empty. The inode at
    // the path differs from the one we created, so release must leave it
    // untouched (A-B-A guard) — regardless of the empty/unverifiable contents.
    await withConfigWriteLock(async () => {
      await fs.unlink(lockPath);
      await fs.writeFile(lockPath, "", "utf-8");
    });

    await expect(fs.access(lockPath)).resolves.toBeUndefined();
    await expect(fs.readFile(lockPath, "utf-8")).resolves.toBe("");
  });

  it("does not delete a successor's lock at a fresh inode whose metadata is unverifiable (malformed)", async () => {
    // A successor's lock at a fresh inode with malformed / legacy contents still
    // must not be deleted: the differing inode proves it is not the file we
    // created, regardless of what its bytes say.
    const foreign = "not-valid-json {";
    await withConfigWriteLock(async () => {
      await fs.unlink(lockPath);
      await fs.writeFile(lockPath, foreign, "utf-8");
    });

    await expect(fs.access(lockPath)).resolves.toBeUndefined();
    await expect(fs.readFile(lockPath, "utf-8")).resolves.toBe(foreign);
  });

  it("does not delete a lock re-acquired by a successor at a fresh inode holding a different token", async () => {
    // Inverse invariant / regression guard: a fully-formed successor lock created
    // at a fresh inode (reap + `wx` re-acquire) must be preserved.
    const successorMeta = {
      pid: process.pid,
      host: os.hostname(),
      token: "successor-token",
      createdAt: Date.now(),
    };
    await withConfigWriteLock(async () => {
      await fs.unlink(lockPath);
      await fs.writeFile(lockPath, JSON.stringify(successorMeta), "utf-8");
    });

    await expect(fs.access(lockPath)).resolves.toBeUndefined();
    const raw = await fs.readFile(lockPath, "utf-8");
    expect((JSON.parse(raw) as { token: string }).token).toBe("successor-token");
  });

  it("deletes the lock it still owns on a normal release (inode unchanged)", async () => {
    // Inverse invariant: the identity check must not cause a holder to leak its
    // own lock. When nobody disturbs the lock, the inode at the path still
    // matches the one captured at acquire, so release removes it as before.
    await withConfigWriteLock(async () => {
      // Critical section leaves the lock exactly as acquireConfigLock wrote it.
    });

    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
