/**
 * Tests for the throttled "update available" startup notifier.
 *
 * The notifier reads a small JSON cache (`<cacheDir>/.update-check.json`),
 * prints a concise stderr notice when a newer published version is already
 * known, and refreshes the cache from the npm registry at most once per 24h.
 * It must NEVER throw, NEVER write to stdout, and must stay suppressed in
 * non-interactive / opted-out environments.
 *
 * Hermetic: every test injects `cacheDir`, `now`, `fetchImpl`, `write`, and
 * `env` — no real network and no real `~/.council` are touched.
 *
 * RED at this commit: src/core/version/update-notifier.ts does not exist.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatUpdateNotice,
  maybeNotifyUpdate,
  readUpdateCache,
  refreshUpdateCache,
  writeUpdateCache,
  type UpdateCache,
} from "../../../../src/core/version/update-notifier.js";

const CACHE_FILENAME = ".update-check.json";
const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_NOW = 1_700_000_000_000;

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("waitFor: condition not met in time");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * A test scheduler that captures the in-flight background refresh promise so a
 * test can deterministically await its completion before assertions/cleanup,
 * instead of racing the fire-and-forget default. `settled()` resolves once
 * every scheduled refresh has fully finished (including its cache write).
 */
function createCaptureScheduler(): {
  scheduleRefresh: (run: () => Promise<void>) => void;
  settled: () => Promise<void>;
} {
  const inFlight: Promise<void>[] = [];
  return {
    scheduleRefresh: (run: () => Promise<void>): void => {
      inFlight.push(run());
    },
    settled: async (): Promise<void> => {
      await Promise.allSettled(inFlight);
    },
  };
}

let cacheDir: string;
let cacheFile: string;
let captured: string[];
let write: (s: string) => void;

beforeEach(async () => {
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "council-update-"));
  cacheFile = path.join(cacheDir, CACHE_FILENAME);
  captured = [];
  write = (s: string): void => {
    captured.push(s);
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(cacheDir, { recursive: true, force: true });
});

describe("readUpdateCache / writeUpdateCache", () => {
  it("round-trips the cache shape", async () => {
    const cache: UpdateCache = { lastCheckMs: FIXED_NOW, latestVersion: "0.3.0" };

    await writeUpdateCache(cacheDir, cache);

    expect(await readUpdateCache(cacheDir)).toEqual(cache);
  });

  it("persists a null latestVersion", async () => {
    await writeUpdateCache(cacheDir, { lastCheckMs: FIXED_NOW, latestVersion: null });

    expect(await readUpdateCache(cacheDir)).toEqual({
      lastCheckMs: FIXED_NOW,
      latestVersion: null,
    });
  });

  it("creates the cache directory if it does not exist", async () => {
    const nested = path.join(cacheDir, "does", "not", "exist");

    await writeUpdateCache(nested, { lastCheckMs: FIXED_NOW, latestVersion: "1.0.0" });

    expect(await readUpdateCache(nested)).toEqual({
      lastCheckMs: FIXED_NOW,
      latestVersion: "1.0.0",
    });
  });

  it("returns null when the cache file is missing", async () => {
    expect(await readUpdateCache(cacheDir)).toBe(null);
  });

  it("returns null (never throws) when the cache file is corrupt", async () => {
    await fs.writeFile(cacheFile, "{ not json", "utf8");

    expect(await readUpdateCache(cacheDir)).toBe(null);
  });

  it("returns null when the cached shape is invalid", async () => {
    await fs.writeFile(cacheFile, JSON.stringify({ lastCheckMs: "soon" }), "utf8");

    expect(await readUpdateCache(cacheDir)).toBe(null);
  });
});

describe("formatUpdateNotice", () => {
  it("mentions both versions and the update commands", () => {
    const notice = stripAnsi(formatUpdateNotice("0.2.1", "0.3.0"));

    expect(notice).toContain("Update available");
    expect(notice).toContain("0.2.1");
    expect(notice).toContain("0.3.0");
    expect(notice).toContain("council update");
    expect(notice).toContain("npm i -g @council-ai/cli");
    expect(notice.endsWith("\n")).toBe(true);
  });
});

describe("refreshUpdateCache", () => {
  it("writes the fetched version with the current timestamp", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "0.4.0" }));

    await refreshUpdateCache({
      fetchImpl,
      cacheDir,
      now: () => FIXED_NOW,
    });

    expect(await readUpdateCache(cacheDir)).toEqual({
      lastCheckMs: FIXED_NOW,
      latestVersion: "0.4.0",
    });
  });

  it("records a null latestVersion (never throws) when the fetch fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });

    await refreshUpdateCache({ fetchImpl, cacheDir, now: () => FIXED_NOW });

    expect(await readUpdateCache(cacheDir)).toEqual({
      lastCheckMs: FIXED_NOW,
      latestVersion: null,
    });
  });
});

describe("maybeNotifyUpdate — suppression", () => {
  const baseOpts = {
    currentVersion: "0.2.1",
  };

  it("does not print or fetch when not attached to a TTY", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "0.3.0" }));
    await writeUpdateCache(cacheDir, {
      lastCheckMs: FIXED_NOW - 2 * DAY_MS,
      latestVersion: "0.3.0",
    });

    await maybeNotifyUpdate({
      ...baseOpts,
      isTTY: false,
      quiet: false,
      env: {},
      write,
      fetchImpl,
      now: () => FIXED_NOW,
      cacheDir,
    });

    expect(captured).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not print or fetch in quiet mode", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "0.3.0" }));
    await writeUpdateCache(cacheDir, {
      lastCheckMs: FIXED_NOW - 2 * DAY_MS,
      latestVersion: "0.3.0",
    });

    await maybeNotifyUpdate({
      ...baseOpts,
      isTTY: true,
      quiet: true,
      env: {},
      write,
      fetchImpl,
      now: () => FIXED_NOW,
      cacheDir,
    });

    expect(captured).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not print or fetch when NO_UPDATE_NOTIFIER is set", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "0.3.0" }));
    await writeUpdateCache(cacheDir, {
      lastCheckMs: FIXED_NOW - 2 * DAY_MS,
      latestVersion: "0.3.0",
    });

    await maybeNotifyUpdate({
      ...baseOpts,
      isTTY: true,
      env: { NO_UPDATE_NOTIFIER: "1" },
      write,
      fetchImpl,
      now: () => FIXED_NOW,
      cacheDir,
    });

    expect(captured).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not print or fetch when CI is set", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "0.3.0" }));
    await writeUpdateCache(cacheDir, {
      lastCheckMs: FIXED_NOW - 2 * DAY_MS,
      latestVersion: "0.3.0",
    });

    await maybeNotifyUpdate({
      ...baseOpts,
      isTTY: true,
      env: { CI: "true" },
      write,
      fetchImpl,
      now: () => FIXED_NOW,
      cacheDir,
    });

    expect(captured).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("maybeNotifyUpdate — printing", () => {
  it("prints a notice when the cached version is newer", async () => {
    await writeUpdateCache(cacheDir, { lastCheckMs: FIXED_NOW, latestVersion: "0.3.0" });

    await maybeNotifyUpdate({
      currentVersion: "0.2.1",
      isTTY: true,
      env: {},
      write,
      now: () => FIXED_NOW,
      cacheDir,
    });

    const output = stripAnsi(captured.join(""));
    expect(output).toContain("Update available");
    expect(output).toContain("0.2.1");
    expect(output).toContain("0.3.0");
  });

  it("does not print when the cached version is not newer", async () => {
    await writeUpdateCache(cacheDir, { lastCheckMs: FIXED_NOW, latestVersion: "0.2.1" });

    await maybeNotifyUpdate({
      currentVersion: "0.2.1",
      isTTY: true,
      env: {},
      write,
      now: () => FIXED_NOW,
      cacheDir,
    });

    expect(captured).toEqual([]);
  });

  it("does not print when the cache is missing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "0.3.0" }));
    const { scheduleRefresh, settled } = createCaptureScheduler();

    await maybeNotifyUpdate({
      currentVersion: "0.2.1",
      isTTY: true,
      env: {},
      write,
      fetchImpl,
      now: () => FIXED_NOW,
      cacheDir,
      scheduleRefresh,
    });

    expect(captured).toEqual([]);
    // A missing cache triggers a background refresh; join it so its write
    // cannot race afterEach teardown of cacheDir.
    await settled();
  });

  it("writes notices to process.stderr by default and never to stdout", async () => {
    await writeUpdateCache(cacheDir, { lastCheckMs: FIXED_NOW, latestVersion: "0.3.0" });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await maybeNotifyUpdate({
      currentVersion: "0.2.1",
      isTTY: true,
      env: {},
      now: () => FIXED_NOW,
      cacheDir,
    });

    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stripAnsi(String(stderrSpy.mock.calls[0]?.[0] ?? ""))).toContain("Update available");
  });
});

describe("maybeNotifyUpdate — refresh throttling", () => {
  it("refreshes the cache when it is missing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "0.3.0" }));

    await maybeNotifyUpdate({
      currentVersion: "0.2.1",
      isTTY: true,
      env: {},
      write,
      fetchImpl,
      now: () => FIXED_NOW,
      cacheDir,
    });

    await waitFor(() => fileExists(cacheFile));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readUpdateCache(cacheDir)).toEqual({
      lastCheckMs: FIXED_NOW,
      latestVersion: "0.3.0",
    });
  });

  it("refreshes the cache when the last check is older than 24h", async () => {
    await writeUpdateCache(cacheDir, {
      lastCheckMs: FIXED_NOW - 2 * DAY_MS,
      latestVersion: "0.3.0",
    });
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "0.4.0" }));

    await maybeNotifyUpdate({
      currentVersion: "0.2.1",
      isTTY: true,
      env: {},
      write,
      fetchImpl,
      now: () => FIXED_NOW,
      cacheDir,
    });

    await waitFor(async () => {
      const cache = await readUpdateCache(cacheDir);
      return cache?.latestVersion === "0.4.0";
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readUpdateCache(cacheDir)).toEqual({
      lastCheckMs: FIXED_NOW,
      latestVersion: "0.4.0",
    });
  });

  it("does not refresh when the cache is still fresh", async () => {
    await writeUpdateCache(cacheDir, {
      lastCheckMs: FIXED_NOW - 60_000,
      latestVersion: "0.3.0",
    });
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "0.4.0" }));

    await maybeNotifyUpdate({
      currentVersion: "0.2.1",
      isTTY: true,
      env: {},
      write,
      fetchImpl,
      now: () => FIXED_NOW,
      cacheDir,
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("maybeNotifyUpdate — joinable refresh seam", () => {
  it("schedules the background refresh through an injected scheduler", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "0.3.0" }));
    const { scheduleRefresh, settled } = createCaptureScheduler();

    await maybeNotifyUpdate({
      currentVersion: "0.2.1",
      isTTY: true,
      env: {},
      write,
      fetchImpl,
      now: () => FIXED_NOW,
      cacheDir,
      scheduleRefresh,
    });

    // The injected scheduler must receive the in-flight refresh so callers
    // (and tests) can join it deterministically rather than racing it.
    await settled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readUpdateCache(cacheDir)).toEqual({
      lastCheckMs: FIXED_NOW,
      latestVersion: "0.3.0",
    });
  });
});

describe("maybeNotifyUpdate — error containment", () => {
  it("never throws when the cache is corrupt", async () => {
    await fs.writeFile(cacheFile, "}}corrupt{{", "utf8");
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "0.3.0" }));
    const { scheduleRefresh, settled } = createCaptureScheduler();

    await expect(
      maybeNotifyUpdate({
        currentVersion: "0.2.1",
        isTTY: true,
        env: {},
        write,
        fetchImpl,
        now: () => FIXED_NOW,
        cacheDir,
        scheduleRefresh,
      }),
    ).resolves.toBeUndefined();

    expect(captured).toEqual([]);
    // Join the background refresh so its cache write cannot race afterEach
    // teardown of cacheDir.
    await settled();
  });

  it("never throws when the background refresh fetch fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    const { scheduleRefresh, settled } = createCaptureScheduler();

    await expect(
      maybeNotifyUpdate({
        currentVersion: "0.2.1",
        isTTY: true,
        env: {},
        write,
        fetchImpl,
        now: () => FIXED_NOW,
        cacheDir,
        scheduleRefresh,
      }),
    ).resolves.toBeUndefined();

    await settled();
    expect(await readUpdateCache(cacheDir)).toEqual({
      lastCheckMs: FIXED_NOW,
      latestVersion: null,
    });
  });
});
