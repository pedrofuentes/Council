import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { E2EContext } from "./helpers.js";

function buildContext(testHome: string, testDataHome: string): E2EContext {
  return {
    testHome,
    testDataHome,
    originalHome: process.env["COUNCIL_HOME"],
    originalDataHome: process.env["COUNCIL_DATA_HOME"],
  };
}

async function importHelpers(): Promise<typeof import("./helpers.js")> {
  return import("./helpers.js");
}

afterEach((): void => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock("node:fs/promises");
});

describe("E2E cleanup helpers", () => {
  it("rejects non-temp paths", async () => {
    const { cleanupE2EContext } = await importHelpers();

    await expect(
      cleanupE2EContext(
        buildContext(
          path.join(process.cwd(), ".should-not-delete-home"),
          path.join(process.cwd(), ".should-not-delete-data"),
        ),
      ),
    ).rejects.toThrow(/Refusing to delete non-temp path/);
  });

  it("rejects the temp root itself", async () => {
    const { cleanupE2EContext } = await importHelpers();

    await expect(
      cleanupE2EContext(buildContext(os.tmpdir(), path.join(os.tmpdir(), "child"))),
    ).rejects.toThrow(/Refusing to delete non-temp path/);
  });

  it("swallows temp-dir removal failures", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-e2e-cleanup-home-"));
    const tempDataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-e2e-cleanup-data-"));
    const rmMock = vi.fn(
      async (
        target: Parameters<typeof fs.rm>[0],
        options?: Parameters<typeof fs.rm>[1],
      ): Promise<void> => {
        if (String(target) === tempHome || String(target) === tempDataHome) {
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        }

        await fs.rm(target, options);
      },
    );

    vi.doMock("node:fs/promises", () => ({
      ...fs,
      rm: rmMock,
    }));

    const { cleanupE2EContext } = await importHelpers();

    try {
      await expect(cleanupE2EContext(buildContext(tempHome, tempDataHome))).resolves.toBeUndefined();
      expect(rmMock).toHaveBeenCalled();
    } finally {
      vi.unmock("node:fs/promises");
      vi.resetModules();
      await fs.rm(tempHome, { recursive: true, force: true });
      await fs.rm(tempDataHome, { recursive: true, force: true });
    }
  });

  it("swallows database destroy errors", async () => {
    const { destroyTestDb } = await importHelpers();
    const db = {
      destroy: vi.fn(async (): Promise<void> => {
        throw new Error("busy");
      }),
    };

    await expect(destroyTestDb(db as never)).resolves.toBeUndefined();
    expect(db.destroy).toHaveBeenCalledOnce();
  });
});
