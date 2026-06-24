/**
 * Tests for the LOCAL telemetry counter store (Milestone 9.10 PR-C).
 *
 * The store persists a content-free `Record<string, number>` of counters to a
 * small JSON file under the Council home. It is LOCAL ONLY — it performs NO
 * network I/O and stores NO content (only static counter keys + integer counts).
 *
 * Design mirrors `src/core/version/update-notifier.ts`:
 *   - reads are tolerant (missing / corrupt / malformed file -> empty map),
 *   - writes are atomic (temp file + rename),
 *   - the whole module is best-effort and never throws on a bad file.
 *
 * Hermetic: every test injects an explicit file path inside a per-test temp
 * directory — no real `~/.council` is touched.
 *
 * RED at this commit: src/tui/lib/telemetry-store.ts does not exist yet.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TELEMETRY_COUNTERS_FILENAME,
  createFileCounterStore,
  readCounters,
  telemetryCountersPath,
  writeCounters,
} from "../../../src/tui/lib/telemetry-store.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "council-telemetry-store-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function counterFile(): string {
  return path.join(dir, TELEMETRY_COUNTERS_FILENAME);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("telemetryCountersPath", () => {
  it("joins the home directory with the counters filename", () => {
    expect(telemetryCountersPath("/home/dir")).toBe(
      path.join("/home/dir", TELEMETRY_COUNTERS_FILENAME),
    );
  });
});

describe("readCounters", () => {
  it("returns an empty map when the file is missing", async () => {
    expect(await readCounters(counterFile())).toEqual({});
  });

  it("reads a valid counter map", async () => {
    await fs.writeFile(counterFile(), JSON.stringify({ "screen.view:home": 3 }), "utf8");
    expect(await readCounters(counterFile())).toEqual({ "screen.view:home": 3 });
  });

  it("returns an empty map for corrupt JSON", async () => {
    await fs.writeFile(counterFile(), "{not valid json", "utf8");
    expect(await readCounters(counterFile())).toEqual({});
  });

  it("returns an empty map for non-object JSON (array / primitive / null)", async () => {
    await fs.writeFile(counterFile(), JSON.stringify([1, 2, 3]), "utf8");
    expect(await readCounters(counterFile())).toEqual({});

    await fs.writeFile(counterFile(), JSON.stringify("a-string"), "utf8");
    expect(await readCounters(counterFile())).toEqual({});

    await fs.writeFile(counterFile(), JSON.stringify(null), "utf8");
    expect(await readCounters(counterFile())).toEqual({});
  });

  it("returns an empty map when a counter value is not a finite number", async () => {
    await fs.writeFile(counterFile(), JSON.stringify({ "screen.view:home": "lots" }), "utf8");
    expect(await readCounters(counterFile())).toEqual({});
  });
});

describe("writeCounters", () => {
  it("creates the parent directory and writes the map atomically", async () => {
    const nested = path.join(dir, "deep", "nested", TELEMETRY_COUNTERS_FILENAME);
    await writeCounters(nested, { "feature.used:export": 2 });

    expect(await readCounters(nested)).toEqual({ "feature.used:export": 2 });
  });
});

describe("createFileCounterStore", () => {
  it("starts empty when no file exists and snapshots increments", async () => {
    const store = await createFileCounterStore(counterFile());

    expect(store.snapshot()).toEqual({});

    store.increment("screen.view:home");
    store.increment("screen.view:home");
    store.increment("feature.used:convene");

    expect(store.snapshot()).toEqual({
      "screen.view:home": 2,
      "feature.used:convene": 1,
    });
  });

  it("loads existing counters and accumulates on top of them", async () => {
    await writeCounters(counterFile(), { "screen.view:home": 5 });

    const store = await createFileCounterStore(counterFile());
    store.increment("screen.view:home");
    store.increment("screen.view:panels");

    expect(store.snapshot()).toEqual({
      "screen.view:home": 6,
      "screen.view:panels": 1,
    });
  });

  it("persists the accumulated counters to disk on flush", async () => {
    const store = await createFileCounterStore(counterFile());
    store.increment("feature.used:export");
    store.increment("feature.used:export");
    await store.flush();

    expect(await readCounters(counterFile())).toEqual({ "feature.used:export": 2 });
  });

  it("does NOT write a file on flush when nothing was incremented", async () => {
    const store = await createFileCounterStore(counterFile());
    await store.flush();

    expect(await fileExists(counterFile())).toBe(false);
  });

  it("snapshots are detached copies — mutating one does not affect the store", async () => {
    const store = await createFileCounterStore(counterFile());
    store.increment("screen.view:home");

    const snapshot = store.snapshot() as Record<string, number>;
    snapshot["screen.view:home"] = 999;

    expect(store.snapshot()).toEqual({ "screen.view:home": 1 });
  });
});
