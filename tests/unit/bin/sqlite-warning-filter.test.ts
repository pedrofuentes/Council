import { describe, expect, it } from "vitest";

import {
  installSqliteExperimentalWarningFilter,
  installSqliteExperimentalWarningStderrFilter,
} from "../../../src/bin/sqlite-warning-filter.js";

interface FakeStderr {
  write: (chunk: string | Uint8Array, encoding?: unknown, cb?: unknown) => boolean;
}

function createFakeStderr(): {
  readonly fakeStderr: FakeStderr;
  readonly writes: readonly string[];
} {
  const writes: string[] = [];
  const fakeStderr: FakeStderr = {
    write: (chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    },
  };
  return { fakeStderr, writes };
}

interface FakeProcess {
  emitWarning: typeof process.emitWarning;
}

function createFakeProcess(): {
  readonly fakeProcess: FakeProcess;
  readonly calls: readonly [string | Error, ...unknown[]][];
} {
  const calls: [string | Error, ...unknown[]][] = [];
  const fakeProcess: FakeProcess = {
    emitWarning: ((warning: string | Error, ...args: unknown[]) => {
      calls.push([warning, ...args]);
    }) as typeof process.emitWarning,
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

describe("installSqliteExperimentalWarningStderrFilter", () => {
  it("suppresses the SQLite ExperimentalWarning line forwarded with the `[CLI subprocess]` prefix from @github/copilot-sdk", () => {
    const { fakeStderr, writes } = createFakeStderr();
    installSqliteExperimentalWarningStderrFilter(fakeStderr);

    fakeStderr.write(
      "[CLI subprocess] (node:63972) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n",
    );
    fakeStderr.write(
      "[CLI subprocess] (Use `node --trace-warnings ...` to show where the warning was created)\n",
    );

    expect(writes).toEqual([]);
  });

  it("suppresses the same warning without the `[CLI subprocess]` prefix (bare Node format)", () => {
    const { fakeStderr, writes } = createFakeStderr();
    installSqliteExperimentalWarningStderrFilter(fakeStderr);

    fakeStderr.write(
      "(node:12345) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n",
    );
    fakeStderr.write(
      "(Use `node --trace-warnings ...` to show where the warning was created)\n",
    );

    expect(writes).toEqual([]);
  });

  it("suppresses both the warning and its trailing trace-warnings hint when delivered in a single chunk", () => {
    const { fakeStderr, writes } = createFakeStderr();
    installSqliteExperimentalWarningStderrFilter(fakeStderr);

    fakeStderr.write(
      "[CLI subprocess] (node:1) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n" +
        "[CLI subprocess] (Use `node --trace-warnings ...` to show where the warning was created)\n",
    );

    expect(writes).toEqual([]);
  });

  it("suppresses the trace-warnings hint when Node names the executable `node.EXE` (Windows argv0)", () => {
    // On Windows, Node derives the hint's executable token from `process.argv0`,
    // which the @github/copilot-sdk subprocess inherits as the parent's
    // `process.execPath`. Depending on how `node` was launched the token can be
    // `node.exe` / `node.EXE` instead of bare `node`. The SQLite warning message
    // line is still dropped (its `(node:PID)` tag is executable-independent), so
    // an unmatched footer leaks ALONE — the contextless footer of PM-05.
    const { fakeStderr, writes } = createFakeStderr();
    installSqliteExperimentalWarningStderrFilter(fakeStderr);

    fakeStderr.write(
      "[CLI subprocess] (node:63972) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n",
    );
    fakeStderr.write(
      "[CLI subprocess] (Use `node.EXE --trace-warnings ...` to show where the warning was created)\n",
    );

    expect(writes).toEqual([]);
  });

  it("suppresses the SQLite warning and its `node.exe`-named hint delivered in a single chunk", () => {
    const { fakeStderr, writes } = createFakeStderr();
    installSqliteExperimentalWarningStderrFilter(fakeStderr);

    fakeStderr.write(
      "[CLI subprocess] (node:1) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n" +
        "[CLI subprocess] (Use `node.exe --trace-warnings ...` to show where the warning was created)\n",
    );

    expect(writes).toEqual([]);
  });

  it("does not drop a `node.EXE`-named hint that follows a non-SQLite ExperimentalWarning", () => {
    const { fakeStderr, writes } = createFakeStderr();
    installSqliteExperimentalWarningStderrFilter(fakeStderr);

    const fetchLine =
      "(node:1) ExperimentalWarning: Fetch is an experimental feature and might change at any time\n";
    const hintLine =
      "(Use `node.EXE --trace-warnings ...` to show where the warning was created)\n";

    fakeStderr.write(fetchLine);
    fakeStderr.write(hintLine);

    expect(writes).toEqual([fetchLine, hintLine]);
  });

  it("passes unrelated stderr content through unchanged", () => {
    const { fakeStderr, writes } = createFakeStderr();
    installSqliteExperimentalWarningStderrFilter(fakeStderr);

    fakeStderr.write("[CLI subprocess] server listening on port 4242\n");
    fakeStderr.write("regular stderr line\n");

    expect(writes).toEqual([
      "[CLI subprocess] server listening on port 4242\n",
      "regular stderr line\n",
    ]);
  });

  it("does not drop the trace-warnings hint when it follows a non-SQLite ExperimentalWarning", () => {
    const { fakeStderr, writes } = createFakeStderr();
    installSqliteExperimentalWarningStderrFilter(fakeStderr);

    const fetchLine =
      "(node:1) ExperimentalWarning: Fetch is an experimental feature and might change at any time\n";
    const hintLine =
      "(Use `node --trace-warnings ...` to show where the warning was created)\n";

    fakeStderr.write(fetchLine);
    fakeStderr.write(hintLine);

    expect(writes).toEqual([fetchLine, hintLine]);
  });

  it("preserves an unrelated line mixed in the same chunk as the SQLite warning", () => {
    const { fakeStderr, writes } = createFakeStderr();
    installSqliteExperimentalWarningStderrFilter(fakeStderr);

    fakeStderr.write(
      "[CLI subprocess] starting up\n" +
        "[CLI subprocess] (node:1) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n" +
        "[CLI subprocess] (Use `node --trace-warnings ...` to show where the warning was created)\n" +
        "[CLI subprocess] ready\n",
    );

    expect(writes.join("")).toBe(
      "[CLI subprocess] starting up\n[CLI subprocess] ready\n",
    );
  });

  it("is idempotent when called twice on the same stream", () => {
    const { fakeStderr, writes } = createFakeStderr();
    installSqliteExperimentalWarningStderrFilter(fakeStderr);
    const wrappedOnce = fakeStderr.write;
    installSqliteExperimentalWarningStderrFilter(fakeStderr);
    expect(fakeStderr.write).toBe(wrappedOnce);

    fakeStderr.write(
      "[CLI subprocess] (node:1) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n",
    );
    expect(writes).toEqual([]);
  });

  it("is installed by installSqliteExperimentalWarningFilter on the provided stderr stream", () => {
    const { fakeProcess, calls } = createFakeProcess();
    const { fakeStderr, writes } = createFakeStderr();
    installSqliteExperimentalWarningFilter(fakeProcess, fakeStderr);

    fakeStderr.write(
      "[CLI subprocess] (node:1) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n",
    );

    expect(writes).toEqual([]);
    expect(calls).toEqual([]);
  });
});
