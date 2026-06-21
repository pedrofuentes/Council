/**
 * The SQLite ExperimentalWarning filter MUST NOT install itself as a
 * module-load side effect. Importing `@council-ai/cli` transitively loads this
 * module, and importing the package must not patch `process.emitWarning` or
 * `process.stderr.write` (see `tests/unit/bin/import-side-effects.test.ts`).
 *
 * The filter is installed explicitly from the `isMainModule` path in
 * `src/bin/council.ts`, never on import. This is the inverse of the previous
 * contract (auto-install on load), which made merely importing the package run
 * CLI bootstrap as a side effect.
 */
import { afterAll, describe, expect, it } from "vitest";

import { installSqliteExperimentalWarningFilter } from "../../../src/bin/sqlite-warning-filter.js";

describe("sqlite-warning-filter module load", () => {
  const originalEmitWarning = process.emitWarning;

  afterAll(() => {
    process.emitWarning = originalEmitWarning;
  });

  it("does not patch process on import — explicit install is required", () => {
    // If the module auto-installed on load, `process.emitWarning` would already
    // be the filter wrapper and this explicit call would be an idempotent no-op
    // (reference unchanged). Because importing the module is inert, the first
    // explicit call is what wraps `emitWarning`, changing the reference.
    const before = process.emitWarning;
    installSqliteExperimentalWarningFilter();
    const after = process.emitWarning;
    expect(after).not.toBe(before);
  });
});
