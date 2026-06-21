/**
 * Importing the package entry (`@council-ai/cli` → `src/index.ts`) must be
 * inert. The package re-exports `buildProgram` for the docs generator and its
 * documented contract is "importing this module does not run the CLI"
 * (see `src/index.ts`).
 *
 * Concretely, a bare import MUST NOT, as an import-time side effect:
 *   - monkey-patch `process.emitWarning` (the SQLite ExperimentalWarning
 *     filter), or
 *   - monkey-patch `process.stderr.write` (the SQLite stderr-line filter), or
 *   - spawn a child process (e.g. the Windows `chcp.com` console code-page
 *     switch).
 *
 * Those effects belong to the CLI bootstrap (`isMainModule` path in
 * `src/bin/council.ts`), not to module evaluation. This test imports the
 * public entry exactly as a tooling consumer would and asserts none of them
 * happen.
 */
import type * as NodeChildProcess from "node:child_process";

import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from "vitest";

// Wrap the child-process spawn family so we can prove the import spawns nothing.
// Each wrapper delegates to the real implementation, so any module that needs
// child_process at runtime still works; we only observe whether it was called.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof NodeChildProcess>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
    execSync: vi.fn(actual.execSync),
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
    exec: vi.fn(actual.exec),
    fork: vi.fn(actual.fork),
  };
});

const SPAWN_FAMILY = ["execFileSync", "execSync", "spawn", "spawnSync", "exec", "fork"] as const;

describe("importing the package entry has no side effects", () => {
  let emitWarningBefore: typeof process.emitWarning;
  let emitWarningAfter: typeof process.emitWarning;
  let stderrWriteBefore: typeof process.stderr.write;
  let stderrWriteAfter: typeof process.stderr.write;
  let spawnCallsDuringImport = 0;

  beforeAll(async () => {
    const cp = await import("node:child_process");
    const spawnCallsBefore = SPAWN_FAMILY.reduce(
      (total, name) => total + (cp[name] as Mock).mock.calls.length,
      0,
    );

    emitWarningBefore = process.emitWarning;
    stderrWriteBefore = process.stderr.write;

    await import("../../../src/index.js");

    emitWarningAfter = process.emitWarning;
    stderrWriteAfter = process.stderr.write;

    const spawnCallsAfter = SPAWN_FAMILY.reduce(
      (total, name) => total + (cp[name] as Mock).mock.calls.length,
      0,
    );
    spawnCallsDuringImport = spawnCallsAfter - spawnCallsBefore;
  });

  afterAll(() => {
    // Defensive: undo any patch a regression might have installed so a failure
    // here cannot leak into other test files sharing this worker process.
    process.emitWarning = emitWarningBefore;
    process.stderr.write = stderrWriteBefore;
  });

  it("does not monkey-patch process.emitWarning", () => {
    expect(emitWarningAfter).toBe(emitWarningBefore);
  });

  it("does not monkey-patch process.stderr.write", () => {
    expect(stderrWriteAfter).toBe(stderrWriteBefore);
  });

  it("does not spawn a child process (e.g. Windows chcp.com)", () => {
    expect(spawnCallsDuringImport).toBe(0);
  });
});
