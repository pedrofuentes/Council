/**
 * Tests for the concurrent first-run race in writeDefaultConfig (#27).
 *
 * When two `council` processes start on a fresh machine, both observe ENOENT
 * in loadConfig() and try to create config.yaml. The default write must use an
 * exclusive create (`wx`) so exactly one writer wins; the loser adopts the
 * winner's file (re-read on EEXIST) instead of clobbering it or reporting a
 * spurious first-run.
 *
 * RED before the fix: writeDefaultConfig() uses a plain fs.writeFile, so no
 * exclusive open is issued and a concurrent create silently overwrites.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    open: vi.fn(actual.open),
  };
});

import { loadConfigWithMeta } from "../../../src/config/index.js";

describe("loadConfig first-run race (#27)", () => {
  let actualFs: typeof fs;
  let testHome: string;
  let configPath: string;
  const originalCouncilHome = process.env["COUNCIL_HOME"];

  beforeEach(async () => {
    actualFs = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(actualFs.open);

    testHome = await actualFs.mkdtemp(path.join(os.tmpdir(), "council-first-run-race-"));
    configPath = path.join(testHome, "config.yaml");
    process.env["COUNCIL_HOME"] = testHome;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (originalCouncilHome === undefined) {
      delete process.env["COUNCIL_HOME"];
    } else {
      process.env["COUNCIL_HOME"] = originalCouncilHome;
    }
    await actualFs.rm(testHome, { recursive: true, force: true });
  });

  it("writes the default config with an exclusive create (wx open)", async () => {
    const result = await loadConfigWithMeta();
    expect(result.isFirstRun).toBe(true);

    const usedExclusiveCreate = vi
      .mocked(fs.open)
      .mock.calls.some(([target, flags]) => target === configPath && String(flags).includes("x"));
    expect(usedExclusiveCreate).toBe(true);
  });

  it("adopts a config created concurrently by another process on EEXIST", async () => {
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const [target, flags] = args;
      if (target === configPath && String(flags).includes("x")) {
        // Another process wins the create race: the file already exists with
        // valid, non-default content by the time our exclusive open runs.
        await actualFs.writeFile(configPath, "defaults:\n  maxRounds: 7\n", "utf-8");
        const err = new Error("EEXIST: file already exists, open") as NodeJS.ErrnoException;
        err.code = "EEXIST";
        throw err;
      }
      return actualFs.open(...args);
    });

    const result = await loadConfigWithMeta();

    // Loser adopts the winner's config rather than overwriting with defaults.
    expect(result.config.defaults.maxRounds).toBe(7);
    // The loser did not create the file, so it is not a first run for it.
    expect(result.isFirstRun).toBe(false);
  });
});
