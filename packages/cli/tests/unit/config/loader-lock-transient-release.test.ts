/**
 * Config-lock RELEASE must not leak the holder's OWN lock when the on-disk lock
 * metadata is TRANSIENTLY unreadable during release (#2102, residual of #2096 /
 * #1923).
 *
 * The token-verified release reads the lock's on-disk metadata to confirm
 * ownership before unlinking. `readLockMeta` collapses a transient read failure
 * (EIO/EACCES/EBUSY/EMFILE under fd exhaustion) into the same `undefined` it
 * returns for "gone/empty/malformed", so a naive `undefined => skip unlink`
 * makes the legitimate holder leave its OWN lock behind on a mere I/O blip —
 * wedging every future writer until the staleness window elapses. That window is
 * never reached for a live same-host owner (e.g. a long-lived interactive Ink
 * TUI / daemon holding `withConfigWriteLock`), whose lock is by design never
 * age-reaped (#742), so the wedge can persist indefinitely.
 *
 * The holder KNOWS it owns the lock: it created the lock this session and holds
 * the session token in memory, and — as a live same-host owner — no reaper can
 * have handed the lock off (#742). A transient read failure during its OWN
 * release must therefore fall back to that in-memory ownership and release the
 * lock. The token-MISMATCH protection (a readable, foreign-owned lock is never
 * unlinked, #1923) must be preserved exactly: it fires only when the read
 * SUCCEEDS and returns a different token.
 *
 * RED before the #2102 fix: `releaseConfigLock` swallows the transient read into
 * `undefined` and returns without unlinking, leaking the holder's own lock.
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

describe("releaseConfigLock transient-read release (#2102)", () => {
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

  it("releases the holder's OWN lock when the lock read fails transiently (EIO) during release", async () => {
    // Transient-failure branch (mandatory): the ONLY lock-file read in a happy,
    // uncontended acquire+release is the release-time ownership check, so making
    // every `.lock` read reject reproduces a transient I/O blip precisely there
    // while the holder still owns the lock (token held in memory).
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

  it("does NOT unlink a readable foreign-owned lock (token mismatch) during release", async () => {
    // Inverse / load-bearing invariant: when the read SUCCEEDS and returns a
    // DIFFERENT holder's fully-formed token, the token-mismatch protection
    // (#1923) must still decline to unlink. Simulate a successor that reaped and
    // re-acquired the lock mid critical-section with its own token; no transient
    // failure is injected, so the release reads the foreign token cleanly.
    const foreignMeta = {
      pid: process.pid,
      host: os.hostname(),
      token: "successor-token-2102",
      createdAt: Date.now(),
    };

    await withConfigWriteLock(async () => {
      await actualFs.writeFile(lockPath, JSON.stringify(foreignMeta), "utf-8");
    });

    // Discriminating oracle: the foreign lock is RETAINED, byte-for-byte.
    await expect(actualFs.access(lockPath)).resolves.toBeUndefined();
    const raw = await actualFs.readFile(lockPath, "utf-8");
    expect((JSON.parse(raw) as { token: string }).token).toBe("successor-token-2102");
  });

  it("unlinks the lock it still owns on a normal release (read succeeds, token matches)", async () => {
    // Regression guard: with no transient failure and no external tampering, the
    // release reads its own matching token and removes the lock exactly as
    // before. Distinguishes the matching-token branch from the two above.
    await expect(withConfigWriteLock(async () => undefined)).resolves.toBeUndefined();

    await expect(actualFs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
