/**
 * Throttled "update available" startup notifier.
 *
 * Design goals:
 *   - The PRINT path is fast: it only reads a small local JSON cache and, if a
 *     newer published version is already known, writes a one-line notice to
 *     stderr. It never blocks on the network.
 *   - The REFRESH path (network read of the npm registry) is deferred and
 *     fire-and-forget. It updates the cache for the *next* run and is throttled
 *     to at most once per 24h.
 *   - The whole module NEVER throws and NEVER writes to stdout. Cache and
 *     network failures are swallowed silently.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import chalk from "chalk";

import { getCouncilHome } from "../../config/index.js";

import { fetchLatestVersion, isNewerVersion, type FetchLatestVersionOptions } from "./registry.js";

const CACHE_FILENAME = ".update-check.json";

/** Refresh the registry probe at most once per 24h. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCache {
  /** Epoch-ms timestamp of the last registry check. */
  readonly lastCheckMs: number;
  /** Latest published version observed, or null if the probe failed. */
  readonly latestVersion: string | null;
}

export interface RefreshUpdateCacheOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly cacheDir?: string;
}

export interface MaybeNotifyUpdateOptions {
  readonly currentVersion: string;
  readonly isTTY?: boolean;
  readonly quiet?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly write?: (s: string) => void;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly cacheDir?: string;
  /**
   * Schedules the throttled background cache refresh. Defaults to a
   * fire-and-forget implementation so the CLI never awaits the network probe
   * and process exit is never delayed. Tests may inject a scheduler that
   * captures the in-flight promise to deterministically join the refresh
   * before assertions/cleanup, eliminating a race with filesystem teardown.
   */
  readonly scheduleRefresh?: (run: () => Promise<void>) => void;
}

function cacheFilePath(cacheDir: string): string {
  return join(cacheDir, CACHE_FILENAME);
}

function isUpdateCache(value: unknown): value is UpdateCache {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const lastCheckMs = record["lastCheckMs"];
  const latestVersion = record["latestVersion"];
  return (
    typeof lastCheckMs === "number" &&
    Number.isFinite(lastCheckMs) &&
    (latestVersion === null || typeof latestVersion === "string")
  );
}

/** Read the update cache. Returns null when missing, corrupt, or malformed. */
export async function readUpdateCache(cacheDir: string): Promise<UpdateCache | null> {
  try {
    const raw = await readFile(cacheFilePath(cacheDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isUpdateCache(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write the update cache atomically (write to a temp file, then rename) so a
 * concurrent reader never observes a half-written file.
 */
export async function writeUpdateCache(cacheDir: string, cache: UpdateCache): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  const finalPath = cacheFilePath(cacheDir);
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(cache), "utf8");
  await rename(tempPath, finalPath);
}

/** Build the one-line, color-aware update notice (chalk respects NO_COLOR). */
export function formatUpdateNotice(current: string, latest: string): string {
  const heading = chalk.yellow("Update available");
  const versions = `${chalk.dim(current)} ${chalk.dim("→")} ${chalk.green(latest)}`;
  const command = chalk.cyan("council update");
  const fallback = chalk.dim("npm i -g @council-ai/cli");
  return `${heading} ${versions} — run \`${command}\` (or \`${fallback}\`).\n`;
}

/**
 * Probe the npm registry and persist the result to the cache. Swallows all
 * errors. Intended to be fired and forgotten so it never delays process exit.
 */
export async function refreshUpdateCache(options: RefreshUpdateCacheOptions = {}): Promise<void> {
  try {
    const now = options.now ?? Date.now;
    const cacheDir = options.cacheDir ?? getCouncilHome();
    const fetchOptions: { fetchImpl?: typeof fetch; timeoutMs?: number } = {};
    if (options.fetchImpl !== undefined) {
      fetchOptions.fetchImpl = options.fetchImpl;
    }
    if (options.timeoutMs !== undefined) {
      fetchOptions.timeoutMs = options.timeoutMs;
    }
    const latestVersion = await fetchLatestVersion(
      fetchOptions satisfies FetchLatestVersionOptions,
    );
    await writeUpdateCache(cacheDir, { lastCheckMs: now(), latestVersion });
  } catch {
    // Best effort: a failed refresh must never surface to the user.
  }
}

function isSuppressed(options: MaybeNotifyUpdateOptions, env: NodeJS.ProcessEnv): boolean {
  const isTTY = options.isTTY ?? false;
  const quiet = options.quiet ?? false;
  return !isTTY || quiet || isSet(env["NO_UPDATE_NOTIFIER"]) || isSet(env["CI"]);
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}

function isStale(lastCheckMs: number, nowMs: number): boolean {
  return nowMs - lastCheckMs >= CHECK_INTERVAL_MS;
}

const writeToStderr = (s: string): void => {
  process.stderr.write(s);
};

/**
 * Default refresh scheduler: fire-and-forget. The promise is intentionally not
 * awaited so the CLI's exit is never delayed by the registry probe.
 */
const fireAndForgetRefresh = (run: () => Promise<void>): void => {
  void run();
};

/**
 * Print an "update available" notice (from cache) and schedule a throttled
 * background refresh. Suppressed when stderr is not a TTY, in quiet mode, or
 * when `NO_UPDATE_NOTIFIER`/`CI` is set. Never throws; never writes to stdout.
 *
 * The print path awaits only a fast local cache read. Any registry refresh is
 * scheduled via {@link MaybeNotifyUpdateOptions.scheduleRefresh}, which defaults
 * to a fire-and-forget call so it never delays exit. Tests may inject a
 * scheduler that joins the in-flight refresh deterministically.
 */
export async function maybeNotifyUpdate(options: MaybeNotifyUpdateOptions): Promise<void> {
  try {
    const env = options.env ?? process.env;
    if (isSuppressed(options, env)) {
      return;
    }

    const now = options.now ?? Date.now;
    const cacheDir = options.cacheDir ?? getCouncilHome();
    const write = options.write ?? writeToStderr;
    const scheduleRefresh = options.scheduleRefresh ?? fireAndForgetRefresh;

    const cache = await readUpdateCache(cacheDir);

    if (
      cache !== null &&
      cache.latestVersion !== null &&
      isNewerVersion(options.currentVersion, cache.latestVersion)
    ) {
      write(formatUpdateNotice(options.currentVersion, cache.latestVersion));
    }

    if (cache === null || isStale(cache.lastCheckMs, now())) {
      const refreshOptions: { fetchImpl?: typeof fetch; now: () => number; cacheDir: string } = {
        now,
        cacheDir,
      };
      if (options.fetchImpl !== undefined) {
        refreshOptions.fetchImpl = options.fetchImpl;
      }
      scheduleRefresh(() => refreshUpdateCache(refreshOptions));
    }
  } catch {
    // The notifier is best effort: never let it affect the CLI's outcome.
  }
}
