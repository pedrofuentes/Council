/**
 * Race regression for `council panel create` (issue #307).
 *
 * The bug Sentinel flagged (SNTNL-R3-PR299-20260512-001 finding F1):
 * `panel create` performs `fs.access(yamlPath)` first, then later calls
 * `fs.writeFile(yamlPath, ...)` without an exclusive-create flag. Two
 * concurrent invocations can both pass the access check (file doesn't
 * exist yet) and then race at the write — the loser silently overwrites
 * the winner's YAML.
 *
 * The fix is to use `O_EXCL` (`flag: 'wx'`) at write time so the OS
 * itself enforces atomic create-only semantics.
 *
 * This test simulates the race by mocking `fs.access` to always report
 * the file as missing (ENOENT) while a file with sentinel bytes has
 * been pre-written at the target path. The buggy impl plows over those
 * bytes; the fixed impl rejects with EEXIST and preserves them.
 */
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  forceMissingPath: null as string | null,
  failWriteForPath: null as string | null,
  failCloseForPath: null as string | null,
}));

import type FsPromisesModule from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>();
  return {
    ...actual,
    access: ((file: unknown, mode?: unknown) => {
      if (
        typeof file === "string" &&
        mockState.forceMissingPath !== null &&
        file === mockState.forceMissingPath
      ) {
        const err: NodeJS.ErrnoException = new Error(
          `ENOENT: no such file or directory, access '${file}'`,
        );
        err.code = "ENOENT";
        return Promise.reject(err);
      }
      return (actual.access as (f: unknown, m?: unknown) => Promise<void>)(file, mode);
    }) as typeof actual.access,
    open: (async (file: unknown, flags?: unknown, mode?: unknown) => {
      const handle = await (
        actual.open as (f: unknown, fl?: unknown, m?: unknown) => Promise<FsPromisesModule.FileHandle>
      )(file, flags, mode);
      if (
        typeof file === "string" &&
        mockState.failWriteForPath !== null &&
        file === mockState.failWriteForPath
      ) {
        const originalWriteFile = handle.writeFile.bind(handle);
        handle.writeFile = (async () => {
          // Simulate a mid-write failure (e.g. ENOSPC) AFTER the OS has
          // already created the file via O_EXCL. Touch the file so callers
          // that drop us mid-way still see real bytes on disk.
          await originalWriteFile("partial bytes from mock\n", "utf-8");
          const err: NodeJS.ErrnoException = new Error(
            "ENOSPC: simulated mid-write failure",
          );
          err.code = "ENOSPC";
          throw err;
        }) as typeof handle.writeFile;
      }
      if (
        typeof file === "string" &&
        mockState.failCloseForPath !== null &&
        file === mockState.failCloseForPath
      ) {
        const originalClose = handle.close.bind(handle);
        handle.close = (async () => {
          // Real close still runs so we don't leak the fd, but the surface
          // call appears to fail — proving the impl preserves the upstream
          // write error rather than letting close() mask it.
          try {
            await originalClose();
          } catch {
            /* ignore — primary error is what matters */
          }
          throw new Error("EIO: simulated close failure");
        }) as typeof handle.close;
      }
      return handle;
    }) as typeof actual.open,
  };
});

import * as fs from "node:fs/promises";

import { buildPanelCommand } from "../../../../src/cli/commands/panel.js";
import { createDatabase } from "../../../../src/memory/db.js";
import { PanelLibraryRepository } from "../../../../src/memory/repositories/panel-library-repo.js";
import type { ExpertDefinition } from "../../../../src/core/expert.js";
import { copyTemplateDb } from "../../../helpers/template-db.js";

interface TestEnv {
  readonly home: string;
  readonly dataHome: string;
  readonly originalHome: string | undefined;
  readonly originalDataHome: string | undefined;
}

function expertDef(slug: string): ExpertDefinition {
  return {
    slug,
    displayName: `Expert ${slug}`,
    role: `${slug} role`,
    expertise: {
      weightedEvidence: ["evidence"],
      referenceCases: [],
      notExpertIn: [],
    },
    epistemicStance: "Empirical",
    kind: "generic",
  };
}

async function seedExpert(env: TestEnv, def: ExpertDefinition): Promise<void> {
  const { FileExpertLibrary } = await import("../../../../src/core/expert-library.js");
  const db = await createDatabase(path.join(env.home, "council.db"));
  try {
    const lib = new FileExpertLibrary(env.dataHome, db);
    await lib.create(def);
  } finally {
    await db.destroy();
  }
}

async function makeEnv(): Promise<TestEnv> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "council-create-excl-home-"));
  const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "council-create-excl-data-"));
  const originalHome = process.env["COUNCIL_HOME"];
  const originalDataHome = process.env["COUNCIL_DATA_HOME"];
  process.env["COUNCIL_HOME"] = home;
  process.env["COUNCIL_DATA_HOME"] = dataHome;
  await copyTemplateDb(path.join(home, "council.db"));
  return { home, dataHome, originalHome, originalDataHome };
}

async function teardown(env: TestEnv): Promise<void> {
  if (env.originalHome === undefined) delete process.env["COUNCIL_HOME"];
  else process.env["COUNCIL_HOME"] = env.originalHome;
  if (env.originalDataHome === undefined) delete process.env["COUNCIL_DATA_HOME"];
  else process.env["COUNCIL_DATA_HOME"] = env.originalDataHome;
  for (const dir of [env.home, env.dataHome]) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* ignore */
    }
  }
}

describe("panel create — O_EXCL atomic write (issue #307)", () => {
  let env: TestEnv;
  beforeEach(async () => {
    mockState.forceMissingPath = null;
    mockState.failWriteForPath = null;
    mockState.failCloseForPath = null;
    env = await makeEnv();
  });
  afterEach(async () => {
    mockState.forceMissingPath = null;
    mockState.failWriteForPath = null;
    mockState.failCloseForPath = null;
    await teardown(env);
  });

  it("refuses to overwrite a pre-existing YAML file even when access pre-check is racy", async () => {
    await seedExpert(env, expertDef("cto"));

    const yamlPath = path.join(env.dataHome, "panels", "arch-review.yaml");
    const sentinel = "name: pre-existing\n# do not overwrite\n";
    await fs.mkdir(path.dirname(yamlPath), { recursive: true });
    await fs.writeFile(yamlPath, sentinel, "utf-8");

    // Simulate the race: existence pre-check reports ENOENT for the YAML
    // path, but the file actually exists when writeFile runs.
    mockState.forceMissingPath = yamlPath;
    let errored = "";
    const cmd = buildPanelCommand(
      () => {
        /* noop */
      },
      (s) => {
        errored += s;
      },
    );

    await expect(
      cmd.parseAsync(["node", "council-panel", "create", "arch-review", "--experts", "cto"]),
    ).rejects.toThrow(/already exists/i);

    // Hard property #1: the user sees a clear "already exists" message.
    expect(errored).toMatch(/already exists/i);

    // Hard property #2: the pre-existing YAML bytes are intact — the
    // racing create did not overwrite them.
    const after = await fs.readFile(yamlPath, "utf-8");
    expect(after).toBe(sentinel);

    // Hard property #3: rollback removed the half-created DB row, so the
    // pre-existing file is not paired with stale metadata.
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new PanelLibraryRepository(db);
      const row = await repo.findByName("arch-review");
      expect(row).toBeUndefined();
    } finally {
      await db.destroy();
    }
  });

  it("rolls back the freshly-created YAML when a mid-write failure occurs after O_EXCL succeeded", async () => {
    await seedExpert(env, expertDef("cto"));

    const yamlPath = path.join(env.dataHome, "panels", "arch-review.yaml");
    // The file does not exist yet — fs.open(...,'wx') will succeed and
    // CREATE the file, then the mocked handle.writeFile will reject.
    mockState.failWriteForPath = yamlPath;

    const cmd = buildPanelCommand(
      () => {
        /* noop */
      },
      () => {
        /* noop */
      },
    );

    await expect(
      cmd.parseAsync(["node", "council-panel", "create", "arch-review", "--experts", "cto"]),
    ).rejects.toThrow(/ENOSPC|simulated mid-write failure/i);

    // Hard property: the freshly-created YAML must be unlinked even though
    // the write itself failed — otherwise a subsequent `panel create`
    // would trip over the orphan file.
    await expect(fs.access(yamlPath)).rejects.toMatchObject({ code: "ENOENT" });

    // And the half-created DB row must be rolled back.
    const db = await createDatabase(path.join(env.home, "council.db"));
    try {
      const repo = new PanelLibraryRepository(db);
      const row = await repo.findByName("arch-review");
      expect(row).toBeUndefined();
    } finally {
      await db.destroy();
    }
  });

  it("preserves the primary write failure when handle.close() also fails", async () => {
    await seedExpert(env, expertDef("cto"));

    const yamlPath = path.join(env.dataHome, "panels", "arch-review.yaml");
    mockState.failWriteForPath = yamlPath;
    mockState.failCloseForPath = yamlPath;

    const cmd = buildPanelCommand(
      () => {
        /* noop */
      },
      () => {
        /* noop */
      },
    );

    const err = await cmd
      .parseAsync(["node", "council-panel", "create", "arch-review", "--experts", "cto"])
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(Error);
    // Hard property: the user-visible failure must surface the original
    // write-time error (or its message), not the secondary close failure.
    const collected: string[] = [];
    const visit = (e: unknown): void => {
      if (e instanceof Error) collected.push(e.message);
      if (e instanceof AggregateError) for (const sub of e.errors) visit(sub);
    };
    visit(err);
    expect(collected.some((m) => /ENOSPC|simulated mid-write failure/i.test(m))).toBe(true);
  });
});
