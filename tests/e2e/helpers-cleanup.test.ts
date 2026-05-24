import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { E2EContext } from "./helpers.js";

interface HelpersModule {
  readonly cleanupE2EContext: (ctx: E2EContext) => Promise<void>;
  readonly destroyTestDb: (db: { destroy: () => Promise<void> }) => Promise<void>;
}

function buildContext(testHome: string, testDataHome: string): E2EContext {
  return {
    testHome,
    testDataHome,
    originalHome: process.env["COUNCIL_HOME"],
    originalDataHome: process.env["COUNCIL_DATA_HOME"],
  };
}

async function importHelpers(): Promise<HelpersModule> {
  return import("./helpers.js");
}

afterEach((): void => {
  vi.restoreAllMocks();
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
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

  it("rejects the temp root itself before deleting anything", async () => {
    const rmMock = vi.fn(async (): Promise<void> => {
      throw new Error("rm should not be called for the temp root");
    });

    vi.doMock("node:fs/promises", () => ({
      ...fs,
      rm: rmMock,
    }));

    const { cleanupE2EContext } = await importHelpers();

    try {
      await expect(cleanupE2EContext(buildContext(os.tmpdir(), os.tmpdir()))).rejects.toThrow(
        /Refusing to delete non-temp path/,
      );
      expect(rmMock).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("waits for the active COUNCIL_DATA_HOME database before cleanup", async () => {
    const originalHome = process.env["COUNCIL_HOME"];
    const originalDataHome = process.env["COUNCIL_DATA_HOME"];
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-e2e-cleanup-home-"));
    const tempDataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-e2e-cleanup-data-"));
    const customDataHome = path.join(tempDataHome, "custom-data-home");
    const destroyMock = vi.fn(async (): Promise<void> => {});
    const createDatabaseMock = vi.fn(async () => ({ destroy: destroyMock }));

    await fs.mkdir(customDataHome, { recursive: true });
    await fs.writeFile(path.join(customDataHome, "council.db"), "", "utf-8");

    vi.doMock("../../src/memory/db.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/memory/db.js")>(
        "../../src/memory/db.js",
      );
      return {
        ...actual,
        createDatabase: createDatabaseMock,
      };
    });

    process.env["COUNCIL_HOME"] = tempHome;
    process.env["COUNCIL_DATA_HOME"] = customDataHome;

    try {
      const { cleanupE2EContext } = await importHelpers();
      await cleanupE2EContext({
        testHome: tempHome,
        testDataHome: tempDataHome,
        originalHome,
        originalDataHome,
      });

      expect(createDatabaseMock).toHaveBeenCalledWith(path.join(customDataHome, "council.db"));
      expect(destroyMock).toHaveBeenCalled();
    } finally {
      if (originalHome === undefined) delete process.env["COUNCIL_HOME"];
      else process.env["COUNCIL_HOME"] = originalHome;

      if (originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
      else process.env["COUNCIL_DATA_HOME"] = originalDataHome;

      await fs.rm(tempHome, { recursive: true, force: true });
      await fs.rm(tempDataHome, { recursive: true, force: true });
    }
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
      await expect(
        cleanupE2EContext(buildContext(tempHome, tempDataHome)),
      ).resolves.toBeUndefined();
      expect(rmMock).toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      await fs.rm(tempHome, { recursive: true, force: true });
      await fs.rm(tempDataHome, { recursive: true, force: true });
    }
  });

  it("rethrows unexpected temp-dir removal failures", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-e2e-cleanup-home-"));
    const tempDataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-e2e-cleanup-data-"));
    const rmMock = vi.fn(async (): Promise<void> => {
      throw new Error("kapow");
    });

    vi.doMock("node:fs/promises", () => ({
      ...fs,
      rm: rmMock,
    }));

    const { cleanupE2EContext } = await importHelpers();

    try {
      await expect(cleanupE2EContext(buildContext(tempHome, tempDataHome))).rejects.toThrow(
        /kapow/,
      );
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      await fs.rm(tempHome, { recursive: true, force: true });
      await fs.rm(tempDataHome, { recursive: true, force: true });
    }
  });

  it("swallows database destroy errors", async () => {
    const { destroyTestDb } = await importHelpers();
    const db = {
      destroy: vi.fn(async (): Promise<void> => {
        throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
      }),
    };

    await expect(destroyTestDb(db as never)).resolves.toBeUndefined();
    expect(db.destroy).toHaveBeenCalledOnce();
  });

  it("rethrows unexpected database destroy errors", async () => {
    const { destroyTestDb } = await importHelpers();
    const db = {
      destroy: vi.fn(async (): Promise<void> => {
        throw new Error("kapow");
      }),
    };

    await expect(destroyTestDb(db as never)).rejects.toThrow(/kapow/);
    expect(db.destroy).toHaveBeenCalledOnce();
  });
});
