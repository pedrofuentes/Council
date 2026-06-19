/**
 * The SQLite ExperimentalWarning filter must auto-install on `process` as
 * a module-load side effect, so that simply importing the filter module
 * (even before any explicit call to `installSqliteExperimentalWarningFilter`)
 * is sufficient to suppress Node's `node:sqlite` ExperimentalWarning — F02.
 *
 * Rationale: in `council.ts`, sibling imports may transitively load
 * `node:sqlite` before line 107's explicit install call runs. Auto-installing
 * on module load closes that gap because the filter module is imported at
 * the top of the entry point and the side effect runs immediately when the
 * module is evaluated.
 */
import { describe, expect, it } from "vitest";

import { installSqliteExperimentalWarningFilter } from "../../../src/bin/sqlite-warning-filter.js";

describe("sqlite-warning-filter module load side effect", () => {
  it("installs the filter on `process` before any explicit call", () => {
    // Capture the (possibly-already-wrapped) emitter, then call the
    // installer again. The WeakSet idempotency guard means a no-op when
    // the filter is already installed; if it were not, the second call
    // would wrap and change the reference.
    const beforeSecondInstall = process.emitWarning;
    installSqliteExperimentalWarningFilter();
    const afterSecondInstall = process.emitWarning;
    expect(afterSecondInstall).toBe(beforeSecondInstall);
  });
});
