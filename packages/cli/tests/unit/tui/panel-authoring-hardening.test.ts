/**
 * Error-handling hardening for the TUI panel-authoring adapter (#1645).
 *
 * These cases pin the failure/rollback paths that a real filesystem cannot be
 * coaxed into exercising deterministically, so `node:fs/promises` is mocked to
 * inject the precise faults:
 *   - a non-Error rejection from `fs.open` (errno guard must not crash);
 *   - a `handle.close()` that throws after a failed `writeFile` (the primary
 *     write error must survive);
 *   - an `fs.mkdir` that creates the panel dir then fails (rollback must remove
 *     the orphaned panel dir).
 * The mock passes through untouched for every path/flag left unset.
 */
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  openRejectPath: null as string | null,
  openRejectValue: null as unknown,
  failWritePath: null as string | null,
  failClosePath: null as string | null,
  mkdirFailAfterCreatePath: null as string | null,
}));

import type FsPromisesModule from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>();
  return {
    ...actual,
    open: (async (file: unknown, flags?: unknown, mode?: unknown) => {
      if (
        typeof file === "string" &&
        mockState.openRejectPath !== null &&
        file === mockState.openRejectPath
      ) {
        return Promise.reject(mockState.openRejectValue);
      }
      const handle = await (
        actual.open as (
          f: unknown,
          fl?: unknown,
          m?: unknown,
        ) => Promise<FsPromisesModule.FileHandle>
      )(file, flags, mode);
      if (
        typeof file === "string" &&
        mockState.failWritePath !== null &&
        file === mockState.failWritePath
      ) {
        const originalWriteFile = handle.writeFile.bind(handle);
        handle.writeFile = (async () => {
          // Touch the file so a fixed impl still has real bytes to roll back,
          // then fail mid-write (e.g. ENOSPC).
          await originalWriteFile("partial bytes from mock\n", "utf-8");
          const err: NodeJS.ErrnoException = new Error("ENOSPC: simulated mid-write failure");
          err.code = "ENOSPC";
          throw err;
        }) as typeof handle.writeFile;
      }
      if (
        typeof file === "string" &&
        mockState.failClosePath !== null &&
        file === mockState.failClosePath
      ) {
        const originalClose = handle.close.bind(handle);
        handle.close = (async () => {
          // Run the real close so we do not leak the fd, but surface a failure
          // to prove the impl does not let close() mask the primary error.
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
    mkdir: (async (target: unknown, options?: unknown) => {
      const realMkdir = actual.mkdir as (t: unknown, o?: unknown) => Promise<string | undefined>;
      if (
        typeof target === "string" &&
        mockState.mkdirFailAfterCreatePath !== null &&
        target === mockState.mkdirFailAfterCreatePath
      ) {
        // Create the directory for real, then fail — simulating a partial
        // mkdir that leaves an orphaned panel dir the rollback must remove.
        await realMkdir(target, options);
        throw new Error("EACCES: simulated mkdir failure after partial create");
      }
      return realMkdir(target, options);
    }) as typeof actual.mkdir,
  };
});

import * as fs from "node:fs/promises";

import {
  createPanelAuthoringSource,
  type PanelAuthoringDataSource,
  type PanelAuthoringDeps,
} from "../../../src/tui/adapters/panel-authoring.js";
import { mkCanonicalTempDir } from "../../helpers/tmp.js";

type PanelRepo = PanelAuthoringDeps["panelRepo"];

interface FakeRepo extends PanelRepo {
  readonly rows: Map<string, unknown>;
  readonly events: string[];
}

function fakeRepo(): FakeRepo {
  const rows = new Map<string, unknown>();
  const events: string[] = [];
  return {
    rows,
    events,
    async create(input) {
      events.push("create");
      rows.set(input.name, input);
    },
    async findByName(name) {
      return rows.get(name);
    },
    async delete(name) {
      events.push("delete");
      rows.delete(name);
    },
    async setMembers(name) {
      events.push(`setMembers:${name}`);
    },
  };
}

interface TestEnv {
  readonly home: string;
  readonly repo: FakeRepo;
}

async function makeEnv(): Promise<TestEnv> {
  return { home: await mkCanonicalTempDir("council-panel-hardening-"), repo: fakeRepo() };
}

async function teardown(env: TestEnv): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    try {
      await fs.rm(env.home, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function sourceFor(env: TestEnv): PanelAuthoringDataSource {
  return createPanelAuthoringSource({
    panelRepo: env.repo,
    expertExists: async () => true,
    dataHome: env.home,
    countDebates: async () => 0,
  });
}

function yamlPathFor(home: string, name: string): string {
  return path.join(home, "panels", `${name}.yaml`);
}

function panelDirFor(home: string, name: string): string {
  return path.join(home, "panels", name);
}

function panelDocsDirFor(home: string, name: string): string {
  return path.join(home, "panels", name, "docs");
}

function resetMockState(): void {
  mockState.openRejectPath = null;
  mockState.openRejectValue = null;
  mockState.failWritePath = null;
  mockState.failClosePath = null;
  mockState.mkdirFailAfterCreatePath = null;
}

describe("createPanelAuthoringSource — error-handling hardening (#1645)", () => {
  let env: TestEnv;

  beforeEach(async () => {
    resetMockState();
    env = await makeEnv();
  });

  afterEach(async () => {
    resetMockState();
    await teardown(env);
  });

  it("re-throws a non-Error open rejection verbatim instead of crashing the errno guard", async () => {
    mockState.openRejectPath = yamlPathFor(env.home, "alpha");
    mockState.openRejectValue = null; // a non-Error, non-object rejection

    const err = await sourceFor(env)
      .create({ name: "alpha", description: null, expertSlugs: ["alice"] })
      .then(
        () => "resolved",
        (e: unknown) => e,
      );

    // An unguarded `(err as NodeJS.ErrnoException).code` throws
    // "Cannot read properties of null (reading 'code')", masking the real
    // rejection. The guarded accessor must let the original value through.
    expect(err).toBeNull();
    // ...and the half-created DB row must still be rolled back.
    expect(env.repo.rows.has("alpha")).toBe(false);
    expect(env.repo.events).toContain("delete");
  });

  it("preserves the writeFile error when handle.close() also throws", async () => {
    const yamlPath = yamlPathFor(env.home, "alpha");
    mockState.failWritePath = yamlPath;
    mockState.failClosePath = yamlPath;

    const err = await sourceFor(env)
      .create({ name: "alpha", description: null, expertSlugs: ["alice"] })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(Error);
    // The finally-block close() must not overwrite the primary write error:
    // the surfaced failure is the ENOSPC write error, never the EIO close one.
    expect((err as Error).message).toMatch(/ENOSPC|simulated mid-write failure/i);
    expect((err as Error).message).not.toMatch(/EIO|simulated close failure/i);
    // The partially-written YAML and DB row are rolled back.
    await expect(fs.access(yamlPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(env.repo.rows.has("alpha")).toBe(false);
  });

  it("removes the orphaned panel directory when docs-dir creation fails", async () => {
    const panelDir = panelDirFor(env.home, "alpha");
    mockState.mkdirFailAfterCreatePath = panelDocsDirFor(env.home, "alpha");

    const err = await sourceFor(env)
      .create({ name: "alpha", description: null, expertSlugs: ["alice"] })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/EACCES|simulated mkdir failure/i);
    // A failed create must fully roll back: the panel dir created as a side
    // effect of the docs mkdir must not be left orphaned on disk, alongside
    // the YAML and DB row.
    await expect(fs.access(panelDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(yamlPathFor(env.home, "alpha"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(env.repo.rows.has("alpha")).toBe(false);
  });
});
