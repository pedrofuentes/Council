/**
 * Tests for stale-lock recovery in updateConfigField (#743) and for the
 * live-owner guard that prevents the #742 config-edit clobber.
 *
 * If a process dies after creating config.yaml.lock, later `config set` calls
 * must reap the stale lock instead of blocking for the full retry window and
 * then failing until the lock is manually removed. A lock is stale only when
 * its recorded owner cannot be shown to be alive: the owner PID is dead on this
 * host, or the metadata is missing/unreadable, or the owner lives on another
 * host (liveness unprobeable) and the file has aged past the staleness window.
 *
 * Crucially, a lock owned by a LIVE process on this host is NEVER stale,
 * regardless of age: a long-running interactive `config edit` legitimately
 * holds the lock for minutes. Reaping such a lock would let a concurrent writer
 * clobber the editor's pending write, silently losing config data (#742).
 *
 * RED before the #743 fix: withConfigLock() only retried on EEXIST and never
 * reaped. RED before the #742 fix: reapIfStale() reaped ANY lock older than the
 * window, even one held by a live owner.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, updateConfigField } from "../../../src/config/index.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("updateConfigField stale-lock recovery (#743)", () => {
  let testHome: string;
  let configPath: string;
  let lockPath: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  beforeEach(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-stale-lock-"));
    configPath = path.join(testHome, "config.yaml");
    lockPath = `${configPath}.lock`;
    process.env["COUNCIL_HOME"] = testHome;
    await fs.writeFile(
      configPath,
      "defaults:\n  model: claude-sonnet-4.5\n  engine: mock\n",
      "utf-8",
    );
  });

  afterEach(async () => {
    if (originalCouncilHome === undefined) {
      delete process.env["COUNCIL_HOME"];
    } else {
      process.env["COUNCIL_HOME"] = originalCouncilHome;
    }
    await fs.rm(testHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("reaps an aged lock whose metadata is unreadable (owner unidentifiable)", async () => {
    // A corrupt/legacy lock file gives the reaper no owner PID to probe, so
    // staleness can only be judged by age. An aged, unattributable lock must
    // still be reaped so a crashed writer can't wedge config edits forever.
    // (The former live-owner variant of this case is now the #742 guard below.)
    await fs.writeFile(lockPath, "corrupt-not-json", "utf-8");
    // Backdate the lock file so it clearly exceeds any reasonable staleness window.
    const stale = new Date(Date.now() - 3_600_000);
    await fs.utimes(lockPath, stale, stale);

    await updateConfigField("defaults.model", "gpt-5");

    const config = await loadConfig();
    expect(config.defaults.model).toBe("gpt-5");
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reaps a lock whose owner PID is no longer alive even when recently created", async () => {
    // An out-of-range PID is guaranteed not to be running (process.kill => ESRCH).
    const deadPid = 2147483647;
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        host: os.hostname(),
        token: "dead-token",
        createdAt: Date.now(),
      }),
      "utf-8",
    );

    await updateConfigField("defaults.model", "gpt-5");

    const config = await loadConfig();
    expect(config.defaults.model).toBe("gpt-5");
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not reap a fresh lock held by a live process", async () => {
    // Lock owned by THIS (alive) process, freshly created => must be respected.
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        token: "live-token",
        createdAt: Date.now(),
      }),
      "utf-8",
    );

    let settled = false;
    const updatePromise = updateConfigField("defaults.model", "gpt-5").finally(() => {
      settled = true;
    });

    await sleep(200);
    expect(settled).toBe(false);
    await expect(fs.readFile(configPath, "utf-8")).resolves.toContain("claude-sonnet-4.5");

    // Owner releases the lock; the waiter should then acquire and finish.
    await fs.unlink(lockPath);
    await expect(updatePromise).resolves.toBeUndefined();

    const config = await loadConfig();
    expect(config.defaults.model).toBe("gpt-5");
  });

  it("does not reap an aged lock still held by a live same-host owner (#742)", async () => {
    // Models a long-running interactive `config edit` that holds the write lock
    // for well over the staleness window. A concurrent `config set` must NOT
    // treat the lock as stale just because it is old: the owner is alive, so
    // reaping it would clobber the editor's pending write (silent loss, #742).
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        token: "aged-live-token",
        createdAt: Date.now() - 3_600_000,
      }),
      "utf-8",
    );
    // Backdate the lock's mtime far beyond the staleness window while its owner
    // (this test process) stays alive.
    const aged = new Date(Date.now() - 3_600_000);
    await fs.utimes(lockPath, aged, aged);

    let settled = false;
    const updatePromise = updateConfigField("defaults.model", "gpt-5").finally(() => {
      settled = true;
    });

    // The live owner still holds the lock: the concurrent writer must block, the
    // lock must survive un-reaped, and config.yaml must be untouched.
    await sleep(200);
    expect(settled).toBe(false);
    await expect(fs.access(lockPath)).resolves.toBeUndefined();
    await expect(fs.readFile(configPath, "utf-8")).resolves.toContain("claude-sonnet-4.5");

    // Once the owner releases the lock, the queued writer acquires it and finishes.
    await fs.unlink(lockPath);
    await expect(updatePromise).resolves.toBeUndefined();

    const config = await loadConfig();
    expect(config.defaults.model).toBe("gpt-5");
  });
});
