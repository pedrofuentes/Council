/**
 * Hardening for the config write-lock's TRANSIENT-fault paths (#2236, from
 * Sentinel review of #2231). Three previously untested/under-hardened branches:
 *
 *   F2 — RELEASE must distinguish a transient `lstat` fault (EIO/EMFILE/…) from
 *        ENOENT. ENOENT means the lock is already gone (silent success). A
 *        transient fault must be RETRIED a bounded number of times so a blip
 *        that clears still lets the holder identify and release its OWN lock;
 *        only if the fault PERSISTS across the bounded retries does release
 *        leave the lock in place (never unlink a file it cannot prove is ours)
 *        AND emit a single sanitized diagnostic — a live same-host owner's lock
 *        is never age-reaped (#742), so a silent persistent strand would wedge
 *        every future writer until the process exits.
 *
 *   F3 — ACQUIRE's identity-capture guard (#1924): if capturing the lock file's
 *        inode identity throws after the exclusive `wx` create, the orphan lock
 *        (which can never be re-created with `wx`) MUST be removed and the error
 *        propagated.
 *
 *   F4 — claimAndReap's rename-to-claim error branches: ENOENT (someone already
 *        reaped it → treat the path as free/claimed) vs a transient non-ENOENT
 *        fault (claimed nothing → leave the lock untouched).
 *
 * Only F2's retry+diagnostic is a behavior change; F3/F4 assert existing branch
 * behavior for regression coverage.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    lstat: vi.fn(actual.lstat),
    stat: vi.fn(actual.stat),
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
  };
});

import { withConfigWriteLock } from "../../../src/config/index.js";

const BASE_CONFIG = "defaults:\n  model: claude-sonnet-4.5\n  engine: mock\n";

/** Guaranteed-ESRCH PID: process.kill(pid, 0) reports it as not alive. */
const DEAD_PID = 2147483647;

function transientError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated transient ${code}`), { code });
}

/** Read the lock file's token, or undefined if gone/unparseable. */
async function lockToken(actualFs: typeof fs, lockPath: string): Promise<string | undefined> {
  try {
    const raw = await actualFs.readFile(lockPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "token" in parsed) {
      const token = (parsed as { token: unknown }).token;
      return typeof token === "string" ? token : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

describe("config lock transient-fault paths (#2236)", () => {
  let actualFs: typeof fs;
  let testHome: string;
  let configPath: string;
  let lockPath: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  function resetMocks(): void {
    vi.mocked(fs.readFile).mockImplementation(actualFs.readFile);
    vi.mocked(fs.lstat).mockImplementation(actualFs.lstat);
    vi.mocked(fs.stat).mockImplementation(actualFs.stat);
    vi.mocked(fs.open).mockImplementation(actualFs.open);
    vi.mocked(fs.rename).mockImplementation(actualFs.rename);
  }

  beforeEach(async () => {
    actualFs = await vi.importActual<typeof fs>("node:fs/promises");
    resetMocks();
    testHome = await actualFs.mkdtemp(path.join(os.tmpdir(), "council-lock-transient-paths-"));
    configPath = path.join(testHome, "config.yaml");
    lockPath = `${configPath}.lock`;
    process.env["COUNCIL_HOME"] = testHome;
    await actualFs.writeFile(configPath, BASE_CONFIG, "utf-8");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetMocks();
    if (originalCouncilHome === undefined) {
      delete process.env["COUNCIL_HOME"];
    } else {
      process.env["COUNCIL_HOME"] = originalCouncilHome;
    }
    await actualFs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  // ---- F2: transient-fault handling at release --------------------------------

  it("releases the OWN lock after a transient lstat fault clears within the bounded retry", async () => {
    // The FIRST release-time lstat of the lock path fails transiently (EIO); the
    // retry observes the real, matching inode identity and the holder unlinks its
    // OWN lock. Under the current no-retry release this transient blip strands the
    // lock (RED); the bounded retry recovers it (GREEN).
    let lockLstatCalls = 0;
    vi.mocked(fs.lstat).mockImplementation(((...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === lockPath) {
        lockLstatCalls += 1;
        if (lockLstatCalls === 1) return Promise.reject(transientError("EIO"));
      }
      return actualFs.lstat(...args);
    }) as typeof fs.lstat);

    await expect(withConfigWriteLock(async () => undefined)).resolves.toBeUndefined();

    // Discriminating oracle: the transient blip was retried, identity matched, and
    // the holder's OWN lock is unlinked (no permanent strand).
    expect(lockLstatCalls).toBeGreaterThanOrEqual(2);
    await expect(actualFs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the lock and emits a sanitized single-line diagnostic when a transient lstat fault persists", async () => {
    // EMFILE on EVERY release-time lstat of the lock path: after the bounded
    // retries the holder still cannot prove ownership, so it MUST NOT unlink
    // (never delete a file it cannot identify) and MUST warn once so operators are
    // not left with a silent permanent strand. Current release swallows the fault
    // silently (RED).
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(fs.lstat).mockImplementation(((...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === lockPath) return Promise.reject(transientError("EMFILE"));
      return actualFs.lstat(...args);
    }) as typeof fs.lstat);

    await expect(withConfigWriteLock(async () => undefined)).resolves.toBeUndefined();

    // Invariant preserved: the lock we cannot prove is ours is left in place.
    await expect(actualFs.access(lockPath)).resolves.toBeUndefined();

    // Exactly one sanitized, single-line diagnostic carrying the error code + a hint.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0];
    expect(typeof message).toBe("string");
    const text = message as string;
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain("EMFILE");
    expect(text).toContain(lockPath);
    // Hint that the strand is bounded by process lifetime, not the reaper.
    expect(text.toLowerCase()).toContain("exit");
  });

  it("emits NO diagnostic and does not unlink when release lstat reports ENOENT (already released)", async () => {
    // Regression guard: ENOENT means the lock is already gone. It must be treated
    // as silent success — no retry-exhaustion warning, no error to the caller.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(fs.lstat).mockImplementation(((...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === lockPath) return Promise.reject(transientError("ENOENT"));
      return actualFs.lstat(...args);
    }) as typeof fs.lstat);

    await expect(withConfigWriteLock(async () => undefined)).resolves.toBeUndefined();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  // ---- F3: acquire identity-capture failure (#1924) ---------------------------

  it("removes the just-created lock and propagates when identity capture fails at acquire", async () => {
    // After the exclusive `wx` create, capturing the file's inode identity via the
    // held handle throws (EIO). The orphan lock — which can never be re-created
    // with `wx` and would wedge every future acquirer — MUST be removed and the
    // error propagated to the caller (#1924).
    const captureError = transientError("EIO");
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actualFs.open(...args);
      if (args[0] === lockPath) {
        handle.stat = (() => Promise.reject(captureError)) as typeof handle.stat;
      }
      return handle;
    });

    // The critical-section fn must never run: acquisition fails before it.
    let ranCriticalSection = false;
    await expect(
      withConfigWriteLock(async () => {
        ranCriticalSection = true;
      }),
    ).rejects.toMatchObject({ code: "EIO" });

    expect(ranCriticalSection).toBe(false);
    // Orphan cleanup: the just-created lock file is removed.
    await expect(actualFs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  // ---- F4: claimAndReap rename ENOENT vs transient ----------------------------

  it("treats a rename ENOENT during claimAndReap as already-reaped and proceeds to acquire", async () => {
    // Plant a stale lock owned by a dead same-host PID so the reaper decides to
    // reap it. When claimAndReap renames the lock aside, ENOENT means a concurrent
    // reaper already removed it → the path is free → acquisition proceeds and
    // succeeds.
    await actualFs.writeFile(
      lockPath,
      JSON.stringify({
        pid: DEAD_PID,
        host: os.hostname(),
        token: "stale-enoent-token",
        createdAt: Date.now(),
      }),
      "utf-8",
    );

    let renameAttempts = 0;
    vi.mocked(fs.rename).mockImplementation((async (...args: Parameters<typeof fs.rename>) => {
      if (args[0] === lockPath) {
        renameAttempts += 1;
        // Simulate a concurrent reaper that already removed the lock.
        await actualFs.rm(lockPath, { force: true });
        throw transientError("ENOENT");
      }
      return actualFs.rename(...args);
    }) as typeof fs.rename);

    let ranCriticalSection = false;
    await expect(
      withConfigWriteLock(async () => {
        ranCriticalSection = true;
      }),
    ).resolves.toBeUndefined();

    expect(renameAttempts).toBeGreaterThanOrEqual(1);
    expect(ranCriticalSection).toBe(true);
    // The acquirer released its own lock on exit.
    await expect(actualFs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the lock untouched when claimAndReap's rename fails transiently (non-ENOENT)", async () => {
    // Plant a stale lock (dead same-host PID) so the reaper decides to reap it. A
    // transient (EPERM) rename means claimAndReap claimed NOTHING, so it must
    // leave the lock in place and report no reap. The acquirer therefore keeps
    // waiting rather than deleting a lock it never claimed.
    await actualFs.writeFile(
      lockPath,
      JSON.stringify({
        pid: DEAD_PID,
        host: os.hostname(),
        token: "stale-transient-token",
        createdAt: Date.now(),
      }),
      "utf-8",
    );

    let renameAttempts = 0;
    vi.mocked(fs.rename).mockImplementation(((...args: Parameters<typeof fs.rename>) => {
      if (args[0] === lockPath) {
        renameAttempts += 1;
        return Promise.reject(transientError("EPERM"));
      }
      return actualFs.rename(...args);
    }) as typeof fs.rename);

    // Start acquisition; it will keep retrying while the reaper leaves the lock in
    // place under the transient rename fault.
    const pending = withConfigWriteLock(async () => undefined);

    // Give the reaper a few attempts, then confirm the stale lock is untouched.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(renameAttempts).toBeGreaterThanOrEqual(1);
    expect(await lockToken(actualFs, lockPath)).toBe("stale-transient-token");

    // Unblock: removing the lock lets the pending acquisition finish so it does
    // not leak, without ever having reaped the stale lock itself.
    await actualFs.rm(lockPath, { force: true });
    await expect(pending).resolves.toBeUndefined();
  });
});
