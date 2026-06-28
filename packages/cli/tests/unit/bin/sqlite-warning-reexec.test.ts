import { describe, expect, it, vi } from "vitest";

import {
  DISABLE_EXPERIMENTAL_WARNING_FLAG,
  REEXEC_SENTINEL_ENV,
  maybeReexecToSuppressSqliteWarning,
  shouldReexecToSuppressSqliteWarning,
  type ReexecDeps,
} from "../../../src/bin/sqlite-warning-reexec.js";

function baseDeps(overrides: Partial<ReexecDeps> = {}): ReexecDeps {
  return {
    platform: "win32",
    execPath: "C:\\Program Files\\node\\node.exe",
    execArgv: [],
    argv: ["C:\\Program Files\\node\\node.exe", "C:\\council\\dist\\bin\\council.js"],
    env: {},
    scriptPath: "C:\\council\\dist\\bin\\council.js",
    stderrIsTTY: true,
    spawnSync: () => ({ status: 0 }),
    ...overrides,
  };
}

describe("shouldReexecToSuppressSqliteWarning", () => {
  it("is true on Windows with an interactive stderr and no flag yet", () => {
    expect(shouldReexecToSuppressSqliteWarning(baseDeps())).toBe(true);
  });

  it("is false on non-Windows platforms (the in-process filter handles those)", () => {
    expect(shouldReexecToSuppressSqliteWarning(baseDeps({ platform: "darwin" }))).toBe(false);
    expect(shouldReexecToSuppressSqliteWarning(baseDeps({ platform: "linux" }))).toBe(false);
  });

  it("is false when stderr is not a TTY (agents / pipes / CI keep the filter)", () => {
    expect(shouldReexecToSuppressSqliteWarning(baseDeps({ stderrIsTTY: false }))).toBe(false);
  });

  it("is false when the re-exec sentinel is already set (prevents an infinite loop)", () => {
    expect(
      shouldReexecToSuppressSqliteWarning(baseDeps({ env: { [REEXEC_SENTINEL_ENV]: "1" } })),
    ).toBe(false);
  });

  it("is false when --disable-warning is already present in execArgv", () => {
    expect(
      shouldReexecToSuppressSqliteWarning(
        baseDeps({ execArgv: ["--disable-warning=ExperimentalWarning"] }),
      ),
    ).toBe(false);
  });

  it("is false when NODE_OPTIONS already disables a warning", () => {
    expect(
      shouldReexecToSuppressSqliteWarning(
        baseDeps({ env: { NODE_OPTIONS: "--disable-warning=ExperimentalWarning" } }),
      ),
    ).toBe(false);
  });
});

describe("maybeReexecToSuppressSqliteWarning", () => {
  it("re-execs node with the disable-warning flag, the script, and forwarded user args", () => {
    const spawnSync = vi.fn(() => ({ status: 0 }));
    const deps = baseDeps({
      execArgv: ["--enable-source-maps"],
      argv: [
        "C:\\Program Files\\node\\node.exe",
        "C:\\council\\dist\\bin\\council.js",
        "convene",
        "--topic",
        "pricing",
      ],
      spawnSync,
    });

    const result = maybeReexecToSuppressSqliteWarning(deps);

    expect(result).toEqual({ reexeced: true, status: 0 });
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnSync.mock.calls[0];
    expect(command).toBe(deps.execPath);
    expect(args).toEqual([
      DISABLE_EXPERIMENTAL_WARNING_FLAG,
      "--enable-source-maps",
      "C:\\council\\dist\\bin\\council.js",
      "convene",
      "--topic",
      "pricing",
    ]);
    expect(options.stdio).toBe("inherit");
    expect(options.env[REEXEC_SENTINEL_ENV]).toBe("1");
  });

  it("forwards the child exit status (and maps a null status to 0)", () => {
    expect(
      maybeReexecToSuppressSqliteWarning(baseDeps({ spawnSync: () => ({ status: 3 }) })).status,
    ).toBe(3);
    expect(
      maybeReexecToSuppressSqliteWarning(baseDeps({ spawnSync: () => ({ status: null }) })).status,
    ).toBe(0);
  });

  it("does not spawn and reports reexeced:false when re-exec is not warranted", () => {
    const spawnSync = vi.fn(() => ({ status: 0 }));
    const result = maybeReexecToSuppressSqliteWarning(
      baseDeps({ platform: "linux", spawnSync }),
    );

    expect(result).toEqual({ reexeced: false, status: 0 });
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
