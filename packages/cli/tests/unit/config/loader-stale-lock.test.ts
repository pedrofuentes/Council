/**
 * Tests for stale-lock recovery in updateConfigField (#743).
 *
 * If a process dies after creating config.yaml.lock, later `config set` calls
 * must reap the stale lock instead of blocking for the full retry window and
 * then failing until the lock is manually removed. Staleness is detected two
 * ways: the lock file is older than the staleness window, or its owner PID is
 * no longer alive. A fresh lock owned by a live process must NOT be reaped.
 *
 * RED before the fix: withConfigLock() only retries on EEXIST and never reaps,
 * so a persistent lock causes updateConfigField() to reject after ~5s.
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

  it("reaps a lock whose file is older than the staleness window", async () => {
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        host: os.hostname(),
        token: "old-token",
        createdAt: Date.now() - 3_600_000,
      }),
      "utf-8",
    );
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
});
