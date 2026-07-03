/**
 * Config-lock RELEASE must (a) never strand the holder's OWN lock and (b) never
 * delete a foreign successor's lock, even when release-time identity probing is
 * disturbed (#2102 own-lock strand; #2118 foreign-delete; residual of #1923).
 *
 * Release proves ownership by the lock file's inode identity ({dev, ino})
 * captured from the still-open acquire handle — NOT by reading the on-disk
 * token. On a normal release the inode at the path is unchanged, so the holder
 * removes its OWN lock. A stranded own-lock would wedge every future writer: the
 * staleness window is never reached for a live same-host owner (e.g. a
 * long-lived interactive Ink TUI / daemon holding `withConfigWriteLock`), whose
 * lock is by design never age-reaped (#742), so the wedge could persist
 * indefinitely. Because release no longer reads the token, a transient readFile
 * fault can no longer collapse ownership into "skip unlink" and strand the lock.
 *
 * The inverse invariant — a foreign successor that reaped + re-acquired the path
 * has a DIFFERENT inode and must be preserved (#1923) — is asserted here and,
 * together with the transient-STAT foreign-delete case (#2118), in
 * loader-lock-inode-identity.test.ts.
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
  };
});

import { withConfigWriteLock } from "../../../src/config/index.js";

const BASE_CONFIG = "defaults:\n  model: claude-sonnet-4.5\n  engine: mock\n";

describe("releaseConfigLock inode-verified release (#2102/#2118)", () => {
  let actualFs: typeof fs;
  let testHome: string;
  let configPath: string;
  let lockPath: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  beforeEach(async () => {
    actualFs = await vi.importActual<typeof fs>("node:fs/promises");
    // Reset the readFile mock to a clean pass-through before each test so a
    // prior test's transient-failure implementation never bleeds across cases.
    vi.mocked(fs.readFile).mockImplementation(actualFs.readFile);

    testHome = await actualFs.mkdtemp(path.join(os.tmpdir(), "council-lock-transient-"));
    configPath = path.join(testHome, "config.yaml");
    lockPath = `${configPath}.lock`;
    process.env["COUNCIL_HOME"] = testHome;
    await actualFs.writeFile(configPath, BASE_CONFIG, "utf-8");
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.mocked(fs.readFile).mockImplementation(actualFs.readFile);
    if (originalCouncilHome === undefined) {
      delete process.env["COUNCIL_HOME"];
    } else {
      process.env["COUNCIL_HOME"] = originalCouncilHome;
    }
    await actualFs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("releases the holder's OWN lock even if a lock-file read fails transiently (EIO) during release", async () => {
    // A transient I/O blip on any `.lock` read must not prevent a holder from
    // releasing its OWN lock. Inode-based release proves ownership via lstat, not
    // by reading the token, so injecting an EIO on every `.lock` readFile leaves a
    // normal release unaffected — the holder still unlinks its own lock. (Under
    // the previous token-reading release this same blip stranded the lock, #2102.)
    const readError = Object.assign(new Error("simulated transient I/O error"), { code: "EIO" });
    vi.mocked(fs.readFile).mockImplementation(
      async (...args: Parameters<typeof fs.readFile>): Promise<string | Buffer> => {
        const target = args[0];
        if (typeof target === "string" && target.endsWith(".lock")) {
          throw readError;
        }
        return actualFs.readFile(...args);
      },
    );

    // Release runs in a `finally`, so the transient blip must not surface as an
    // error to the caller...
    await expect(withConfigWriteLock(async () => undefined)).resolves.toBeUndefined();

    // ...and the discriminating oracle: the holder's OWN lock is UNLINKED — the
    // transient read does not strand it and wedge future writers.
    await expect(actualFs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does NOT unlink a foreign successor's lock at a fresh inode during release", async () => {
    // Inverse / load-bearing invariant: a successor reaped our lock and
    // re-acquired the path with a FRESH inode (unlink + `wx` create) and its own
    // token. Release must leave it untouched — the inode differs from the one we
    // captured at acquire (#1923). No transient fault is injected, so release
    // stats the successor's file cleanly and still declines to unlink it.
    const foreignMeta = {
      pid: process.pid,
      host: os.hostname(),
      token: "successor-token-2102",
      createdAt: Date.now(),
    };

    await withConfigWriteLock(async () => {
      await actualFs.unlink(lockPath);
      await actualFs.writeFile(lockPath, JSON.stringify(foreignMeta), "utf-8");
    });

    // Discriminating oracle: the foreign lock is RETAINED, byte-for-byte.
    await expect(actualFs.access(lockPath)).resolves.toBeUndefined();
    const raw = await actualFs.readFile(lockPath, "utf-8");
    expect((JSON.parse(raw) as { token: string }).token).toBe("successor-token-2102");
  });

  it("unlinks the lock it still owns on a normal release (inode unchanged)", async () => {
    // Regression guard: with no transient failure and no external tampering, the
    // inode at the path still matches the identity captured at acquire and the
    // release removes the lock exactly as before. Distinguishes the matching
    // branch from the two above.
    await expect(withConfigWriteLock(async () => undefined)).resolves.toBeUndefined();

    await expect(actualFs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
