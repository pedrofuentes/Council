/**
 * Inode-identity hardening of the config lock: release and reap must only ever
 * remove the EXACT lock file this process created, proven structurally by the
 * file's {dev, ino} identity — never a foreign successor's lock that happens to
 * occupy the same path (#1923 A-B-A, #2118 transient-unlink foreign-delete).
 *
 * Why inode identity is decisive: the lock protocol only ever creates a lock via
 * an exclusive `wx` open on a FREE path. A successor therefore cannot overwrite a
 * live lock in place — it must first remove the old file (reap/release) and then
 * create its own, which necessarily yields a DIFFERENT inode. So "same inode at
 * the path" ⇔ "still the file we created", and any inode change reveals a
 * reap+recreate hand-off that we must not delete out from under the new owner.
 *
 * RED (current token/blind-unlink code) vs GREEN (inode-identity code):
 *   #1 (#2118): release that hits a TRANSIENT stat/read error while a DIFFERENT
 *       inode occupies the path blind-unlinks that foreign file (RED); the
 *       inode-based release refuses to unlink what it cannot positively identify.
 *   #2 (#1923 release A-B-A): a successor that reaped+recreated our lock with a
 *       fresh inode — even reusing our exact token — is deleted by the token-only
 *       release (RED); the inode-based release preserves it.
 *   #3 (#2102): a normal release whose inode still matches DOES unlink our own
 *       lock (no strand in the common case) — preserved under both designs.
 *   #4 (#1923 reaper A-B-A): a reaper that decided lock A is stale deletes a
 *       successor lock B that replaced A between decision and removal via the
 *       non-atomic stat-then-unlink (RED); the rename-to-claim + re-verify reaper
 *       restores B and aborts.
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
  };
});

import { updateConfigField, withConfigWriteLock } from "../../../src/config/index.js";

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

describe("config lock inode identity", () => {
  let actualFs: typeof fs;
  let testHome: string;
  let configPath: string;
  let lockPath: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  beforeEach(async () => {
    actualFs = await vi.importActual<typeof fs>("node:fs/promises");
    // Default both mocks to a clean pass-through so a prior test's failure
    // implementation never bleeds across cases (only #1 and #4 override them).
    vi.mocked(fs.readFile).mockImplementation(actualFs.readFile);
    vi.mocked(fs.lstat).mockImplementation(actualFs.lstat);
    vi.mocked(fs.stat).mockImplementation(actualFs.stat);
    vi.mocked(fs.open).mockImplementation(actualFs.open);

    testHome = await actualFs.mkdtemp(path.join(os.tmpdir(), "council-lock-inode-"));
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
    if (originalCouncilHome === undefined) {
      delete process.env["COUNCIL_HOME"];
    } else {
      process.env["COUNCIL_HOME"] = originalCouncilHome;
    }
    await actualFs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("does NOT unlink a foreign successor's lock when release hits a transient stat error (#2118)", async () => {
    // A successor reaped our lock and re-acquired with a FRESH inode + its own
    // token. Then release-time identity probing fails transiently (EIO under fd
    // exhaustion). The token-only release reads the path, hits the transient
    // error, and BLIND-UNLINKS whatever is there — deleting the foreign lock. The
    // inode-based release cannot prove the file is ours and must leave it alone.
    const foreignMeta = {
      pid: process.pid,
      host: os.hostname(),
      token: "foreign-successor-2118",
      createdAt: Date.now(),
    };
    const eio = Object.assign(new Error("simulated transient I/O error"), { code: "EIO" });

    // Drive BOTH release implementations to their failure branch: the old
    // release reads the lock via readFile; the new release stats it via lstat.
    vi.mocked(fs.readFile).mockImplementation(
      async (...args: Parameters<typeof fs.readFile>): Promise<string | Buffer> => {
        if (args[0] === lockPath) throw eio;
        return actualFs.readFile(...args);
      },
    );
    vi.mocked(fs.lstat).mockImplementation((...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === lockPath) return Promise.reject(eio);
      return actualFs.lstat(...args);
    });

    await expect(
      withConfigWriteLock(async () => {
        // Successor reaps our lock (removing our inode) and re-acquires: a NEW,
        // distinct inode now occupies the path.
        await actualFs.unlink(lockPath);
        await actualFs.writeFile(lockPath, JSON.stringify(foreignMeta), "utf-8");
      }),
    ).resolves.toBeUndefined();

    // Discriminating oracle: the FOREIGN lock survives byte-for-byte.
    await expect(actualFs.access(lockPath)).resolves.toBeUndefined();
    expect(await lockToken(actualFs, lockPath)).toBe("foreign-successor-2118");
  });

  it("does NOT unlink a successor's lock reaped+recreated with a fresh inode, even reusing our token (#1923 release A-B-A)", async () => {
    // The nastiest A-B-A: a successor reaped our lock and re-acquired the path,
    // and (worst case, forced here) its lock carries our EXACT token. The
    // token-only release sees a matching token and deletes the successor's lock;
    // the inode-based release sees a different inode and preserves it. No I/O
    // fault is injected — release reads the successor cleanly.
    let successorToken: string | undefined;

    await expect(
      withConfigWriteLock(async () => {
        // Capture our on-disk lock bytes, then reap+recreate the lock at a NEW
        // inode carrying identical bytes (same token) — the token check cannot
        // tell this apart from our own lock.
        const ourRaw = await actualFs.readFile(lockPath, "utf-8");
        successorToken = await lockToken(actualFs, lockPath);
        await actualFs.unlink(lockPath);
        await actualFs.writeFile(lockPath, ourRaw, "utf-8");
      }),
    ).resolves.toBeUndefined();

    // Discriminating oracle: the successor's lock (fresh inode, our token) is
    // retained — the inode mismatch, not the token, governs deletion.
    await expect(actualFs.access(lockPath)).resolves.toBeUndefined();
    expect(successorToken).toBeDefined();
    expect(await lockToken(actualFs, lockPath)).toBe(successorToken);
  });

  it("unlinks our OWN lock on a normal release when the inode still matches (#2102 preserved)", async () => {
    // Common case: nobody disturbs the lock, so the inode at the path is still
    // the exact file we created and release removes it — no strand, no wedge.
    await expect(withConfigWriteLock(async () => undefined)).resolves.toBeUndefined();

    await expect(actualFs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does NOT delete a successor lock that replaced a stale lock between the reaper's decision and its removal (#1923 reaper A-B-A)", async () => {
    // Plant a stale lock A (dead PID, same host) so acquisition's reaper decides
    // to reap it. Inject an A-B-A race precisely at the reaper's deciding read:
    // when it reads A's metadata, a successor reaps A and re-acquires with a
    // FRESH inode, a LIVE owner, and a DIFFERENT token. The non-atomic
    // stat-then-unlink reaper then unlinks the path — destroying the successor's
    // lock B (RED). The rename-to-claim + re-verify reaper claims the swapped
    // file, detects it is not the lock it decided to reap, and puts it back.
    const deadPid = 2147483647; // guaranteed ESRCH: process.kill => not alive
    await actualFs.writeFile(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        host: os.hostname(),
        token: "stale-A-token-reaper",
        createdAt: Date.now(),
      }),
      "utf-8",
    );

    const successorMeta = {
      pid: process.pid, // LIVE => never legitimately reaped on later passes
      host: os.hostname(),
      token: "successor-B-token-reaper",
      createdAt: Date.now(),
    };

    let swapped = false;
    let notifySwapped!: () => void;
    const swapHappened = new Promise<void>((resolve) => {
      notifySwapped = resolve;
    });

    vi.mocked(fs.readFile).mockImplementation(
      async (...args: Parameters<typeof fs.readFile>): Promise<string | Buffer> => {
        // Fire only on the reaper's FIRST deciding read of the lock path; the
        // claimed file it re-reads is a distinct ".stale-*" name and passes
        // through, as do all config-file reads.
        if (!swapped && args[0] === lockPath) {
          swapped = true;
          const originalStaleContent = await actualFs.readFile(lockPath, "utf-8");
          await actualFs.unlink(lockPath);
          await actualFs.writeFile(lockPath, JSON.stringify(successorMeta), "utf-8");
          notifySwapped();
          // Return A's ORIGINAL bytes so the reaper still decides to reap A.
          return originalStaleContent;
        }
        return actualFs.readFile(...args);
      },
    );

    const update = updateConfigField("defaults.model", "gpt-5");
    // Wait until the successor lock B is in place, then give the reaper a beat to
    // run its removal/claim step against it.
    await swapHappened;
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Discriminating oracle: the successor's LIVE lock B is intact.
    expect(await lockToken(actualFs, lockPath)).toBe("successor-B-token-reaper");

    // Cleanup: releasing B lets the (otherwise indefinitely blocked) acquisition
    // finish so the pending update settles instead of leaking.
    await actualFs.rm(lockPath, { force: true }).catch(() => undefined);
    await update.catch(() => undefined);
  });
});

/**
 * Non-authoritative `st_ino` hardening (#2118 shared-FS multi-host target).
 *
 * On NFS/SMB/CIFS/some FUSE/overlay mounts libuv can report `st_ino = 0` or
 * unstable/reused values, and 64-bit ids read as JS `number` lose precision past
 * 2^53. Structural inode identity is therefore only trustworthy when `st_ino` is
 * stable and non-zero. These tests pin the fail-safe: when the observed `ino` is
 * `0n` (or two distinct 64-bit inodes collide as JS numbers), ownership is NOT
 * provable, so release must NOT unlink and the reaper structural fallback must
 * NOT reap — never destroy a lock we cannot positively prove is ours.
 *
 * RED (raw `number` compare, no zero-guard) vs GREEN (bigint compare + fail-safe):
 *   #A: release observes `ino=0n` for both our captured id and the foreign file
 *       at the path → `0===0` false-matches and blind-unlinks the foreign lock
 *       (RED); the guarded release refuses (unprovable identity).
 *   #B: reaper structural fallback observes `ino=0n` → `0===0` false-matches a
 *       swapped-in successor and reaps it (RED); the guarded fallback returns
 *       false and restores the successor.
 *   #C: two 64-bit inodes that round to the SAME JS number (…992 vs …993) are
 *       treated as equal by the `number` compare and the foreign lock is unlinked
 *       (RED); the bigint compare distinguishes them and preserves it.
 */
describe("config lock non-authoritative st_ino (fail-safe)", () => {
  let actualFs: typeof fs;
  let testHome: string;
  let configPath: string;
  let lockPath: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  /** Build a Stats-like object honouring the `{ bigint: true }` option. */
  function fakeStats(dev: bigint, ino: bigint, opts: unknown, mtimeMs = Date.now()): unknown {
    const bigint =
      typeof opts === "object" && opts !== null && (opts as { bigint?: boolean }).bigint === true;
    return bigint
      ? { dev, ino, mtimeMs: BigInt(Math.trunc(mtimeMs)) }
      : { dev: Number(dev), ino: Number(ino), mtimeMs };
  }

  beforeEach(async () => {
    actualFs = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.readFile).mockImplementation(actualFs.readFile);
    vi.mocked(fs.lstat).mockImplementation(actualFs.lstat);
    vi.mocked(fs.stat).mockImplementation(actualFs.stat);
    vi.mocked(fs.open).mockImplementation(actualFs.open);

    testHome = await actualFs.mkdtemp(path.join(os.tmpdir(), "council-lock-ino0-"));
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
    if (originalCouncilHome === undefined) {
      delete process.env["COUNCIL_HOME"];
    } else {
      process.env["COUNCIL_HOME"] = originalCouncilHome;
    }
    await actualFs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("does NOT unlink a foreign lock at release when st_ino reports 0 (unprovable identity)", async () => {
    // Simulate a filesystem whose st_ino collapses to 0 for every entry: BOTH the
    // acquire-time capture (handle.stat) and the release-time compare (fs.lstat)
    // observe ino=0 with the same dev. A raw `dev===dev && ino===ino` compare then
    // reads `0===0 → true` and unlinks whatever occupies the path — here a foreign
    // successor's lock. The guarded release must treat ino=0 as unprovable.
    const foreignMeta = {
      pid: process.pid,
      host: os.hostname(),
      token: "foreign-ino0-2118",
      createdAt: Date.now(),
    };

    // Our own lock's captured identity: dev=1, ino=0 (authoritative id unavailable).
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actualFs.open(...args);
      if (args[0] === lockPath) {
        handle.stat = ((opts?: unknown) =>
          Promise.resolve(fakeStats(1n, 0n, opts))) as typeof handle.stat;
      }
      return handle;
    });
    // Release-time lstat of the (now foreign) file at the path also reports ino=0.
    vi.mocked(fs.lstat).mockImplementation(((...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === lockPath) return Promise.resolve(fakeStats(1n, 0n, args[1]));
      return actualFs.lstat(...args);
    }) as typeof fs.lstat);

    await expect(
      withConfigWriteLock(async () => {
        // A successor reaps our lock and re-acquires the path with its own file.
        await actualFs.unlink(lockPath);
        await actualFs.writeFile(lockPath, JSON.stringify(foreignMeta), "utf-8");
      }),
    ).resolves.toBeUndefined();

    // Discriminating oracle: the foreign lock survives — ino=0 is not proof.
    await expect(actualFs.access(lockPath)).resolves.toBeUndefined();
    expect(await lockToken(actualFs, lockPath)).toBe("foreign-ino0-2118");
  });

  it("does NOT reap a swapped-in successor via the structural fallback when st_ino reports 0", async () => {
    // Plant a stale lock A with UNREADABLE metadata (forcing the reaper's
    // structural inode fallback rather than the token path), aged past
    // LOCK_STALE_MS. On the reaper's deciding metadata read, a successor reaps A
    // and re-acquires with a fresh, LIVE, DIFFERENT lock B. With st_ino reported
    // as 0 the structural fallback reads `0===0 → true` and unlinks B (RED); the
    // guarded fallback must return false and restore B.
    await actualFs.writeFile(lockPath, "not-valid-lock-json", "utf-8");
    const oldMs = Date.now() - 60_000;
    await actualFs.utimes(lockPath, oldMs / 1000, oldMs / 1000);

    const successorMeta = {
      pid: process.pid, // LIVE => never legitimately reaped on later passes
      host: os.hostname(),
      token: "successor-B-ino0",
      createdAt: Date.now(),
    };

    // Override ino to 0 for the lock path and any claimed (renamed-aside) file,
    // preserving the real mtime so the age decision still fires.
    vi.mocked(fs.stat).mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
      const target = args[0];
      if (
        typeof target === "string" &&
        (target === lockPath || target.startsWith(`${lockPath}.stale-`))
      ) {
        const real = await actualFs.stat(...(args as Parameters<typeof actualFs.stat>));
        return fakeStats(BigInt(real.dev), 0n, args[1], Number(real.mtimeMs));
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
          // reaper takes the structural inode fallback.
          return "not-valid-lock-json";
        }
        return actualFs.readFile(...args);
      },
    );

    const update = updateConfigField("defaults.model", "gpt-5");
    await swapHappened;
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Discriminating oracle: the LIVE successor lock B is intact.
    expect(await lockToken(actualFs, lockPath)).toBe("successor-B-ino0");

    await actualFs.rm(lockPath, { force: true }).catch(() => undefined);
    await update.catch(() => undefined);
  });

  it("treats two 64-bit inodes that collide as a JS number as DIFFERENT identities", async () => {
    // 9007199254740993 and 9007199254740992 are distinct inodes but round to the
    // same IEEE-754 double: a `number` compare false-matches and unlinks a foreign
    // successor; a bigint compare distinguishes them and preserves it.
    const ourIno = 9007199254740993n;
    const foreignIno = 9007199254740992n;
    expect(Number(ourIno)).toBe(Number(foreignIno)); // precondition: number collision

    const foreignMeta = {
      pid: process.pid,
      host: os.hostname(),
      token: "foreign-precision",
      createdAt: Date.now(),
    };

    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actualFs.open(...args);
      if (args[0] === lockPath) {
        handle.stat = ((opts?: unknown) =>
          Promise.resolve(fakeStats(1n, ourIno, opts))) as typeof handle.stat;
      }
      return handle;
    });
    vi.mocked(fs.lstat).mockImplementation(((...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === lockPath) return Promise.resolve(fakeStats(1n, foreignIno, args[1]));
      return actualFs.lstat(...args);
    }) as typeof fs.lstat);

    await expect(
      withConfigWriteLock(async () => {
        await actualFs.unlink(lockPath);
        await actualFs.writeFile(lockPath, JSON.stringify(foreignMeta), "utf-8");
      }),
    ).resolves.toBeUndefined();

    // Discriminating oracle: the foreign lock (distinct 64-bit inode) survives.
    await expect(actualFs.access(lockPath)).resolves.toBeUndefined();
    expect(await lockToken(actualFs, lockPath)).toBe("foreign-precision");
  });
});
