import { describe, expect, it } from "vitest";

import { installSqliteExperimentalWarningFilter } from "../../../src/bin/sqlite-warning-filter.js";

interface FakeProcess {
  emitWarning: (warning: string | Error, ...args: unknown[]) => void;
}

function createFakeProcess(): {
  readonly fakeProcess: FakeProcess;
  readonly calls: readonly [string | Error, ...unknown[]][];
} {
  const calls: Array<[string | Error, ...unknown[]]> = [];
  const fakeProcess: FakeProcess = {
    emitWarning: (warning: string | Error, ...args: unknown[]) => {
      calls.push([warning, ...args]);
    },
  };

  return { fakeProcess, calls };
}

describe("installSqliteExperimentalWarningFilter", () => {
  it("suppresses Node's SQLite ExperimentalWarning", () => {
    const { fakeProcess, calls } = createFakeProcess();
    installSqliteExperimentalWarningFilter(fakeProcess);

    fakeProcess.emitWarning(
      "SQLite is an experimental feature and might change at any time",
      "ExperimentalWarning",
    );

    expect(calls).toEqual([]);
  });

  it("does not suppress non-SQLite ExperimentalWarning values", () => {
    const { fakeProcess, calls } = createFakeProcess();
    installSqliteExperimentalWarningFilter(fakeProcess);

    fakeProcess.emitWarning(
      "Fetch is an experimental feature and might change at any time",
      "ExperimentalWarning",
    );

    expect(calls).toEqual([
      ["Fetch is an experimental feature and might change at any time", "ExperimentalWarning"],
    ]);
  });

  it("does not suppress non-Experimental warnings that mention sqlite", () => {
    const { fakeProcess, calls } = createFakeProcess();
    installSqliteExperimentalWarningFilter(fakeProcess);

    fakeProcess.emitWarning("sqlite connection fell back to a cached handle", "Warning");

    expect(calls).toEqual([["sqlite connection fell back to a cached handle", "Warning"]]);
  });
});
