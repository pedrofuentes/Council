/**
 * Degraded-mode availability recovery for the config lock on filesystems whose
 * `st_ino` is not authoritative (reported as 0 on some NFS/SMB/CIFS/FUSE mounts —
 * the #2118 multi-host target). Inode identity is the PRIMARY ownership proof, but
 * when it is unavailable (ino=0) three data-safety fail-safes previously degraded
 * into permanent availability wedges. These tests pin the recovered behaviour,
 * corroborating ownership via the on-disk lock metadata (token/createdAt) and, as
 * a bounded last resort for unreadable metadata, the file's mtime + size — WITHOUT
 * ever deleting a lock we cannot positively prove is stale or ours.
 *
 * RED (fail-safe-only code) vs GREEN (metadata/mtime corroboration):
 *   T1 (F1 release self-wedge): on ino=0, releasing our OWN lock (readable meta on
 *       disk carrying our token) is stranded forever by inode-only release (RED);
 *       the token fallback unlinks it.
 *   T2 (F1 safety): on ino=0, a foreign successor's meta (different token) at the
 *       path is NEVER unlinked by the token fallback (GREEN under both).
 *   T3 (F2 reap wedge): a stale, aged, UNREADABLE-meta lock on ino=0 with stable
 *       mtime/size can never be reaped by the structural fallback (RED wedge); the
 *       mtime+size last resort reaps it so acquisition succeeds.
 *   T4 (F2 safety): on ino=0 unreadable-meta, a successor that swapped in between
 *       decision and claim has a DIFFERENT mtime, so the last resort refuses to
 *       reap and restores it (GREEN preserves it).
 *   T5 (F3 churn): an abandoned unreadable-meta ino=0 lock is reaped on the FIRST
 *       attempt (mtime corroborates) — no per-retry rename-away/rename-back churn.
 *   T6 (F1 A-B-A window): on ino=0, a foreign successor that reap+recreates the
 *       lock in the t1→t2 window between release observing OUR token and acting on
 *       the path is NEVER destroyed. A non-atomic read-meta-then-unlink-by-path
 *       deletes that live successor (RED, config data loss #2235); the atomic
 *       rename-to-claim + token re-verify only ever unlinks a claimed (renamed-
 *       aside) copy, never lockPath directly, so the successor survives (GREEN).
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
    unlink: vi.fn(actual.unlink),
  };
});

import { loadConfig, updateConfigField, withConfigWriteLock } from "../../../src/config/index.js";

const BASE_CONFIG = "defaults:\n  model: claude-sonnet-4.5\n  engine: mock\n";

/** Read the lock file's token, or undefined if the lock is gone/unparseable. */
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

describe("config lock degraded-mode recovery (non-authoritative st_ino)", () => {
  let actualFs: typeof fs;
  let testHome: string;
  let configPath: string;
  let lockPath: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  /**
   * Build a Stats-like object honouring the `{ bigint: true }` option, forcing
   * `ino` to a caller-chosen value while preserving controllable mtime + size so
   * the age gate and the mtime/size corroboration can be exercised precisely.
   */
  function fakeStats(
    dev: bigint,
    ino: bigint,
    opts: unknown,
    mtimeMs: number,
    size: number,
  ): unknown {
    const bigint =
      typeof opts === "object" && opts !== null && (opts as { bigint?: boolean }).bigint === true;
    return bigint
      ? { dev, ino, mtimeMs: BigInt(Math.trunc(mtimeMs)), size: BigInt(Math.trunc(size)) }
      : { dev: Number(dev), ino: Number(ino), mtimeMs, size };
  }

  beforeEach(async () => {
    actualFs = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.readFile).mockImplementation(actualFs.readFile);
    vi.mocked(fs.lstat).mockImplementation(actualFs.lstat);
    vi.mocked(fs.stat).mockImplementation(actualFs.stat);
    vi.mocked(fs.open).mockImplementation(actualFs.open);
    vi.mocked(fs.rename).mockImplementation(actualFs.rename);
    vi.mocked(fs.unlink).mockImplementation(actualFs.unlink);

    testHome = await actualFs.mkdtemp(path.join(os.tmpdir(), "council-lock-degraded-"));
    configPath = path.join(testHome, "config.yaml");
    lockPath = `${configPath}.lock`;
    process.env["COUNCIL_HOME"] = testHome;
    await actualFs.writeFile(configPath, BASE_CONFIG, "utf-8");
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.mocked(fs.readFile).mockImplementation(actualFs.readFile);
    vi.mocked(fs.lstat).mockImplementation(actualFs.lstat);
    vi.mocked(fs.stat).mockImplementation(actualFs.stat);
    vi.mocked(fs.open).mockImplementation(actualFs.open);
    vi.mocked(fs.rename).mockImplementation(actualFs.rename);
    vi.mocked(fs.unlink).mockImplementation(actualFs.unlink);
    if (originalCouncilHome === undefined) {
      delete process.env["COUNCIL_HOME"];
    } else {
      process.env["COUNCIL_HOME"] = originalCouncilHome;
    }
    await actualFs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("T1 (F1): unlinks our OWN lock on release when st_ino is 0 via the token fallback", async () => {
    // Our acquire-time identity is unprovable (handle.stat reports ino=0) and the
    // release-time lstat also reports ino=0, so the inode-only proof can never
    // match. Nobody disturbs the lock: the file at the path still carries the
    // token we wrote. The inode-only release strands it forever (RED); the token
    // fallback recognises it as ours and unlinks it.
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actualFs.open(...args);
      if (args[0] === lockPath) {
        handle.stat = ((opts?: unknown) =>
          Promise.resolve(fakeStats(1n, 0n, opts, Date.now(), 100))) as typeof handle.stat;
      }
      return handle;
    });
    vi.mocked(fs.lstat).mockImplementation(((...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === lockPath) return Promise.resolve(fakeStats(1n, 0n, args[1], Date.now(), 100));
      return actualFs.lstat(...args);
    }) as typeof fs.lstat);

    await expect(withConfigWriteLock(async () => undefined)).resolves.toBeUndefined();

    // Discriminating oracle: our own lock is gone — no self-wedge for future writes.
    await expect(actualFs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("T2 (F1 safety): does NOT unlink a foreign lock (different token) on release when st_ino is 0", async () => {
    // Same ino=0 degraded release, but a foreign successor swapped its own lock in
    // (its own random token). The token fallback must see the token MISMATCH and
    // refuse to unlink — never delete a lock we cannot prove is ours.
    const foreignMeta = {
      pid: process.pid,
      host: os.hostname(),
      token: "foreign-token-2235",
      createdAt: Date.now(),
    };
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actualFs.open(...args);
      if (args[0] === lockPath) {
        handle.stat = ((opts?: unknown) =>
          Promise.resolve(fakeStats(1n, 0n, opts, Date.now(), 100))) as typeof handle.stat;
      }
      return handle;
    });
    vi.mocked(fs.lstat).mockImplementation(((...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === lockPath) return Promise.resolve(fakeStats(1n, 0n, args[1], Date.now(), 100));
      return actualFs.lstat(...args);
    }) as typeof fs.lstat);

    await expect(
      withConfigWriteLock(async () => {
        await actualFs.unlink(lockPath);
        await actualFs.writeFile(lockPath, JSON.stringify(foreignMeta), "utf-8");
      }),
    ).resolves.toBeUndefined();

    // Discriminating oracle: the foreign lock survives byte-for-byte.
    await expect(actualFs.access(lockPath)).resolves.toBeUndefined();
    expect(await lockToken(actualFs, lockPath)).toBe("foreign-token-2235");
  });

  it("T3 (F2): reaps a stale, unreadable-meta lock on st_ino=0 via the mtime/size last resort", async () => {
    // A crashed holder left an unreadable-meta lock aged well past LOCK_STALE_MS.
    // On ino=0 the structural fallback can never confirm it, so it is wedged
    // forever (RED: acquisition exhausts its retries and throws). The mtime+size
    // last resort corroborates the aged file across the atomic claim and reaps it,
    // so acquisition succeeds and the update lands.
    await actualFs.writeFile(lockPath, "not-valid-lock-json", "utf-8");
    const oldMs = Date.now() - 60_000;
    await actualFs.utimes(lockPath, oldMs / 1000, oldMs / 1000);

    // Report ino=0 for the lock path and any claimed (renamed-aside) copy while
    // preserving the real mtime + size, so the age gate fires and the last-resort
    // corroboration sees a stable file across the atomic rename.
    vi.mocked(fs.stat).mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
      const target = args[0];
      if (
        typeof target === "string" &&
        (target === lockPath || target.startsWith(`${lockPath}.stale-`))
      ) {
        const real = await actualFs.stat(...(args as Parameters<typeof actualFs.stat>));
        return fakeStats(BigInt(real.dev), 0n, args[1], Number(real.mtimeMs), Number(real.size));
      }
      return actualFs.stat(...(args as Parameters<typeof actualFs.stat>));
    }) as typeof fs.stat);

    await expect(updateConfigField("defaults.model", "gpt-5")).resolves.toBeUndefined();

    // Discriminating oracle: the wedge cleared and the write landed.
    const config = await loadConfig();
    expect(config.defaults.model).toBe("gpt-5");
  });

  it("T4 (F2 safety): does NOT reap when a successor swapped in with a different mtime (st_ino=0)", async () => {
    // Stale unreadable-meta lock A aged past LOCK_STALE_MS. On the reaper's
    // deciding metadata read, a successor reaps A and re-acquires a fresh, LIVE
    // lock B (its own token, a newer mtime). With ino=0 the only signal is mtime +
    // size, which now DIFFERS from the decision — so the last resort must refuse to
    // reap and restore B.
    await actualFs.writeFile(lockPath, "not-valid-lock-json", "utf-8");
    const oldMs = Date.now() - 60_000;
    await actualFs.utimes(lockPath, oldMs / 1000, oldMs / 1000);

    const successorMeta = {
      pid: process.pid, // LIVE => never legitimately reaped on later passes
      host: os.hostname(),
      token: "successor-B-degraded",
      createdAt: Date.now(),
    };

    vi.mocked(fs.stat).mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
      const target = args[0];
      if (
        typeof target === "string" &&
        (target === lockPath || target.startsWith(`${lockPath}.stale-`))
      ) {
        const real = await actualFs.stat(...(args as Parameters<typeof actualFs.stat>));
        return fakeStats(BigInt(real.dev), 0n, args[1], Number(real.mtimeMs), Number(real.size));
      }
      return actualFs.stat(...(args as Parameters<typeof actualFs.stat>));
    }) as typeof fs.stat);

    let swapped = false;
    let notifySwapped!: () => void;
    const swapHappened = new Promise<void>((resolve) => {
      notifySwapped = resolve;
    });
    vi.mocked(fs.readFile).mockImplementation(
      async (...args: Parameters<typeof fs.readFile>): Promise<string | Buffer> => {
        if (!swapped && args[0] === lockPath) {
          swapped = true;
          await actualFs.unlink(lockPath);
          await actualFs.writeFile(lockPath, JSON.stringify(successorMeta), "utf-8");
          notifySwapped();
          // Return A's original unreadable bytes so meta stays undefined and the
          // reaper takes the ino=0 last-resort path.
          return "not-valid-lock-json";
        }
        return actualFs.readFile(...args);
      },
    );

    const update = updateConfigField("defaults.model", "gpt-5");
    await swapHappened;
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Discriminating oracle: the LIVE successor lock B is intact.
    expect(await lockToken(actualFs, lockPath)).toBe("successor-B-degraded");

    await actualFs.rm(lockPath, { force: true }).catch(() => undefined);
    await update.catch(() => undefined);
  });

  it("T5 (F3): reaps an abandoned unreadable-meta ino=0 lock on the first attempt without rename churn", async () => {
    // The abandoned-lock counterpart of T3: verify the reap happens on the FIRST
    // stale attempt rather than churning the rename-away/rename-back dance once per
    // acquire retry. We count renames of the lock path itself: exactly one claim.
    await actualFs.writeFile(lockPath, "not-valid-lock-json", "utf-8");
    const oldMs = Date.now() - 60_000;
    await actualFs.utimes(lockPath, oldMs / 1000, oldMs / 1000);

    vi.mocked(fs.stat).mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
      const target = args[0];
      if (
        typeof target === "string" &&
        (target === lockPath || target.startsWith(`${lockPath}.stale-`))
      ) {
        const real = await actualFs.stat(...(args as Parameters<typeof actualFs.stat>));
        return fakeStats(BigInt(real.dev), 0n, args[1], Number(real.mtimeMs), Number(real.size));
      }
      return actualFs.stat(...(args as Parameters<typeof actualFs.stat>));
    }) as typeof fs.stat);

    await expect(updateConfigField("defaults.model", "gpt-5")).resolves.toBeUndefined();

    // The reaper renames the lock path aside exactly once to claim it; a churning
    // implementation would rename it away once per acquire retry (many times).
    const lockClaimRenames = vi
      .mocked(fs.rename)
      .mock.calls.filter((call) => call[0] === lockPath).length;
    expect(lockClaimRenames).toBe(1);
  });

  it("T6 (F1 A-B-A safety): never deletes a foreign successor that swaps in during the ino=0 release window", async () => {
    // Reproduces the #2235 🔴: on a non-authoritative-st_ino filesystem a
    // foreign-host reaper can reap+recreate the lock in the tiny window between
    // release observing OUR token and acting on the path. A non-atomic
    // read-meta-then-unlink-by-path deletes that foreign successor's LIVE lock
    // (config data loss). The atomic rename-to-claim + token re-verify collapses
    // the window: release only ever unlinks a file it exclusively renamed aside,
    // never lockPath directly, so the successor survives.
    const foreignMeta = {
      pid: process.pid,
      host: os.hostname(),
      token: "foreign-successor-window-2235",
      createdAt: Date.now(),
    };

    // ino=0 at acquire (handle.stat) and at release (lstat) so the inode proof can
    // never match, forcing the metadata token fallback.
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actualFs.open(...args);
      if (args[0] === lockPath) {
        handle.stat = ((opts?: unknown) =>
          Promise.resolve(fakeStats(1n, 0n, opts, Date.now(), 100))) as typeof handle.stat;
      }
      return handle;
    });

    let releaseStarted = false;
    vi.mocked(fs.lstat).mockImplementation(((...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === lockPath) {
        releaseStarted = true;
        return Promise.resolve(fakeStats(1n, 0n, args[1], Date.now(), 100));
      }
      return actualFs.lstat(...args);
    }) as typeof fs.lstat);

    // Swap a FOREIGN successor's lock in at lockPath at the instant release
    // observes OUR token (the t1→t2 window). In the non-atomic impl that read is
    // of lockPath itself and the subsequent unlink(lockPath) destroys the foreign
    // lock; in the atomic impl the read is of the already-claimed (renamed-aside)
    // copy, so lockPath is free and the foreign lock we plant simply survives.
    let swapped = false;
    vi.mocked(fs.readFile).mockImplementation(
      async (...args: Parameters<typeof fs.readFile>): Promise<string | Buffer> => {
        const result = await actualFs.readFile(...args);
        if (releaseStarted && !swapped && typeof result === "string") {
          let token: unknown;
          try {
            token = (JSON.parse(result) as { token?: unknown }).token;
          } catch {
            token = undefined;
          }
          if (typeof token === "string" && token !== foreignMeta.token) {
            swapped = true;
            await actualFs.rm(lockPath, { force: true });
            await actualFs.writeFile(lockPath, JSON.stringify(foreignMeta), "utf-8");
          }
        }
        return result;
      },
    );

    await expect(withConfigWriteLock(async () => undefined)).resolves.toBeUndefined();

    // The swap must actually have fired inside the release window, else the test
    // proves nothing about the A-B-A window.
    expect(swapped).toBe(true);

    // (a) The foreign successor's LIVE lock SURVIVES release, byte-for-byte.
    await expect(actualFs.access(lockPath)).resolves.toBeUndefined();
    expect(await lockToken(actualFs, lockPath)).toBe(foreignMeta.token);

    // (b) Release NEVER unlinks lockPath directly — it only removes a claimed
    //     (renamed-aside) copy, and it claims via rename(lockPath → *.releasing-*).
    const unlinkedLockPathDirectly = vi
      .mocked(fs.unlink)
      .mock.calls.some((call) => call[0] === lockPath);
    expect(unlinkedLockPathDirectly).toBe(false);
    const claimedByRename = vi
      .mocked(fs.rename)
      .mock.calls.some(
        (call) =>
          call[0] === lockPath &&
          typeof call[1] === "string" &&
          call[1].startsWith(`${lockPath}.releasing-`),
      );
    expect(claimedByRename).toBe(true);
  });
});
