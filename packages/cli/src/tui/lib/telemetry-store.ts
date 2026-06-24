/**
 * LOCAL telemetry counter store (Milestone 9.10 PR-C).
 *
 * Persists a content-free `Record<string, number>` of counters to a small JSON
 * file under the Council home (`<home>/telemetry-counters.json`). It is LOCAL
 * ONLY: it performs NO network I/O and stores NO content — only static counter
 * keys (e.g. `"screen.view:home"`) mapped to integer counts.
 *
 * Design mirrors {@link ../../core/version/update-notifier}:
 *   - reads are tolerant: a missing, corrupt, or malformed file yields an empty
 *     map rather than throwing,
 *   - writes are atomic: serialise to a temp file, then rename into place so a
 *     concurrent reader never observes a half-written file,
 *   - `flush` is dirty-gated, so a session that never recorded anything (e.g.
 *     telemetry disabled) never creates the file.
 *
 * Counts accumulate across runs because the store seeds its in-memory map from
 * the on-disk file at construction. Concurrent processes are last-flush-wins;
 * for a best-effort local counter that is acceptable (and matches the update
 * notifier's cache semantics).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const TELEMETRY_COUNTERS_FILENAME = "telemetry-counters.json";

export type TelemetryCounters = Readonly<Record<string, number>>;

export interface FileCounterStore {
  /** Increment the in-memory counter for `key` by one. */
  readonly increment: (key: string) => void;
  /** A detached copy of the current counters. */
  readonly snapshot: () => TelemetryCounters;
  /** Atomically persist the counters to disk. A NO-OP when nothing changed. */
  readonly flush: () => Promise<void>;
}

/** Resolve the counters file path under a Council home directory. */
export function telemetryCountersPath(home: string): string {
  return join(home, TELEMETRY_COUNTERS_FILENAME);
}

function isCounterMap(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(
    (count) => typeof count === "number" && Number.isFinite(count),
  );
}

/** Read the counter map. Returns an empty map when missing, corrupt, or malformed. */
export async function readCounters(filePath: string): Promise<Record<string, number>> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isCounterMap(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

/**
 * Write the counter map atomically (temp file + rename). Creates the parent
 * directory if needed; mode `0o600` keeps the (already content-free) file
 * private, consistent with other Council-written files.
 */
export async function writeCounters(filePath: string, counters: TelemetryCounters): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(counters), { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
}

/**
 * Build a file-backed counter store seeded from the on-disk counters. The
 * `increment`/`snapshot` paths are synchronous and in-memory; `flush` persists
 * the accumulated counts and is a NO-OP if nothing was incremented.
 */
export async function createFileCounterStore(filePath: string): Promise<FileCounterStore> {
  const counters: Record<string, number> = await readCounters(filePath);
  let dirty = false;

  return {
    increment: (key: string): void => {
      counters[key] = (counters[key] ?? 0) + 1;
      dirty = true;
    },
    snapshot: (): TelemetryCounters => ({ ...counters }),
    flush: async (): Promise<void> => {
      if (!dirty) return;
      await writeCounters(filePath, counters);
      dirty = false;
    },
  };
}
