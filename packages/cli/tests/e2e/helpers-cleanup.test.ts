import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type * as MemoryDbModule from "../../src/memory/db.js";
import type { E2EContext, TurnPairingEvent } from "./helpers.js";
import { isBestEffortCleanupError, pairTurnEventsByExpert } from "./helpers.js";

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

  it("does not open the database during cleanup (decoupled from DB readiness)", async () => {
    const originalHome = process.env["COUNCIL_HOME"];
    const originalDataHome = process.env["COUNCIL_DATA_HOME"];
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-e2e-cleanup-home-"));
    const tempDataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-e2e-cleanup-data-"));
    const customDataHome = path.join(tempDataHome, "custom-data-home");
    const destroyMock = vi.fn(async (): Promise<void> => undefined);
    const createDatabaseMock = vi.fn(async () => ({ destroy: destroyMock }));

    await fs.mkdir(customDataHome, { recursive: true });
    await fs.writeFile(path.join(customDataHome, "council.db"), "", "utf-8");

    vi.doMock("../../src/memory/db.js", async () => {
      const actual = await vi.importActual<typeof MemoryDbModule>("../../src/memory/db.js");
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

      // Cleanup must NOT open the database — that would block on leaked
      // handles and is unnecessary because removeDir's retry loop already
      // absorbs Windows EBUSY/EPERM during file deletion.
      expect(createDatabaseMock).not.toHaveBeenCalled();
      expect(destroyMock).not.toHaveBeenCalled();
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

describe("isBestEffortCleanupError word-boundary regression guard (#647)", () => {
  it.each([
    { label: "EBUSY via .code", error: Object.assign(new Error("file in use"), { code: "EBUSY" }) },
    {
      label: "EPERM via .code",
      error: Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
    },
    {
      label: "ENOTEMPTY via .code",
      error: Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" }),
    },
    { label: "sqlite_busy in message", error: new Error("SqliteError: sqlite_busy") },
    { label: "database is locked in message", error: new Error("database is locked") },
  ])("returns true — $label", ({ error }) => {
    expect(isBestEffortCleanupError(error)).toBe(true);
  });

  // These cases contain an allowlisted token as a substring of a larger word.
  // A regex without \b word-boundary anchoring would incorrectly return true.
  it.each([
    {
      label: "EPERMISSIVE (EPERM is a prefix, not a standalone token)",
      error: new Error("EPERMISSIVE: access denied"),
    },
    {
      label: "sqlite_busy_lock (sqlite_busy is a prefix, not a standalone token)",
      error: new Error("sqlite_busy_lock: timeout exceeded"),
    },
  ])("returns false — $label", ({ error }) => {
    expect(isBestEffortCleanupError(error)).toBe(false);
  });
});

describe("pairTurnEventsByExpert identity-based pairing (#637)", () => {
  // Sentinel finding from PR #631 (#637): expert-panel-crud.test.ts paired
  // turn.start/turn.end events by array-index stride (i, i+1), which
  // silently assumes the two events for a given expert are positionally
  // adjacent in the stream. These cases prove pairing-by-expertSlug
  // tolerates legitimate ordering variation that positional pairing cannot.

  it("pairs turns nested inside another expert's turn (start A, start B, end B, end A)", () => {
    // A stride-based (i, i+1) pairing would wrongly compare turnEvents[0]
    // (start A) against turnEvents[1] (start B) here and fail spuriously.
    const events: readonly TurnPairingEvent[] = [
      { kind: "turn.start", expertSlug: "alpha" },
      { kind: "turn.start", expertSlug: "beta" },
      { kind: "turn.end", expertSlug: "beta" },
      { kind: "turn.end", expertSlug: "alpha" },
    ];

    const pairs = pairTurnEventsByExpert(events);

    expect(pairs.map((pair) => pair.expertSlug).sort()).toEqual(["alpha", "beta"]);
    for (const pair of pairs) {
      expect(pair.start.expertSlug).toBe(pair.expertSlug);
      expect(pair.end.expertSlug).toBe(pair.expertSlug);
    }
  });

  it("pairs turns that cross rather than nest (start A, start B, end A, end B)", () => {
    const events: readonly TurnPairingEvent[] = [
      { kind: "turn.start", expertSlug: "alpha" },
      { kind: "turn.start", expertSlug: "beta" },
      { kind: "turn.end", expertSlug: "alpha" },
      { kind: "turn.end", expertSlug: "beta" },
    ];

    const pairs = pairTurnEventsByExpert(events);

    expect(pairs).toHaveLength(2);
    expect(pairs.find((pair) => pair.expertSlug === "alpha")?.end.expertSlug).toBe("alpha");
    expect(pairs.find((pair) => pair.expertSlug === "beta")?.end.expertSlug).toBe("beta");
  });

  it("still pairs correctly under today's strict serial ordering", () => {
    const events: readonly TurnPairingEvent[] = [
      { kind: "turn.start", expertSlug: "alpha" },
      { kind: "turn.end", expertSlug: "alpha" },
      { kind: "turn.start", expertSlug: "beta" },
      { kind: "turn.end", expertSlug: "beta" },
    ];

    expect(pairTurnEventsByExpert(events)).toHaveLength(2);
  });

  it("ignores non-turn events interspersed in the stream", () => {
    const events: readonly TurnPairingEvent[] = [
      { kind: "panel.assembled" },
      { kind: "round.start" },
      { kind: "turn.start", expertSlug: "alpha" },
      { kind: "turn.delta", expertSlug: "alpha" },
      { kind: "turn.end", expertSlug: "alpha" },
      { kind: "cost.update" },
      { kind: "debate.end" },
    ];

    const pairs = pairTurnEventsByExpert(events);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.expertSlug).toBe("alpha");
  });

  // A real ordering bug must still surface — pairing-by-identity must not
  // paper over a dropped or duplicated event.
  it("throws when a turn.end has no matching prior turn.start for that expert", () => {
    const events: readonly TurnPairingEvent[] = [
      { kind: "turn.start", expertSlug: "alpha" },
      { kind: "turn.end", expertSlug: "beta" },
    ];

    expect(() => pairTurnEventsByExpert(events)).toThrow(/no matching turn\.start/i);
  });

  it("throws when a turn.start is left dangling with no turn.end", () => {
    const events: readonly TurnPairingEvent[] = [
      { kind: "turn.start", expertSlug: "alpha" },
      { kind: "turn.start", expertSlug: "beta" },
      { kind: "turn.end", expertSlug: "beta" },
    ];

    expect(() => pairTurnEventsByExpert(events)).toThrow(/no matching turn\.end/i);
  });

  it("throws when the same expert has two turns in flight at once", () => {
    const events: readonly TurnPairingEvent[] = [
      { kind: "turn.start", expertSlug: "alpha" },
      { kind: "turn.start", expertSlug: "alpha" },
      { kind: "turn.end", expertSlug: "alpha" },
      { kind: "turn.end", expertSlug: "alpha" },
    ];

    expect(() => pairTurnEventsByExpert(events)).toThrow(/two turns in flight/i);
  });
});
