/**
 * Tests for `council update` — upgrade the globally-installed Council CLI.
 *
 * Every test is hermetic: the version fetcher, the package-manager runner,
 * the confirmation prompt, and the spinner are injected mocks. No real
 * child process is spawned and no real network request is made.
 */
import { describe, expect, it, vi } from "vitest";

import { CliUserError } from "../../../../src/cli/cli-user-error.js";
import {
  buildUpdateCommand,
  buildUpgradeArgs,
  classifyExecFileResult,
  detectPackageManager,
  isPackageManager,
  type PackageManager,
  type UpdateCommandDeps,
  type UpgradeRunResult,
  type UpgradeRunner,
} from "../../../../src/cli/commands/update.js";
import { EXIT_NETWORK_ERROR } from "../../../../src/cli/exit-codes.js";

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly error: unknown;
}

function noopSpinner(): { start: () => void; stop: () => void } {
  return { start: () => undefined, stop: () => undefined };
}

async function runUpdate(
  args: readonly string[],
  deps: UpdateCommandDeps = {},
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const cmd = buildUpdateCommand({
    write:
      deps.write ??
      ((s: string) => {
        stdout += s;
      }),
    writeError:
      deps.writeError ??
      ((s: string) => {
        stderr += s;
      }),
    createSpinner: deps.createSpinner ?? noopSpinner,
    env: deps.env ?? {},
    ...deps,
  });
  cmd.exitOverride();
  let error: unknown = undefined;
  await cmd.parseAsync(["node", "council-update", ...args]).catch((err: unknown) => {
    error = err;
  });
  return { stdout, stderr, error };
}

function okRunner(): UpgradeRunner {
  return vi.fn(
    async (): Promise<UpgradeRunResult> => ({ exitCode: 0, stdout: "done", stderr: "" }),
  );
}

describe("detectPackageManager", () => {
  it("detects pnpm from the npm_config_user_agent", () => {
    expect(detectPackageManager({ userAgent: "pnpm/9.15.0 npm/? node/v22.0.0" })).toBe("pnpm");
  });

  it("detects yarn from the npm_config_user_agent", () => {
    expect(detectPackageManager({ userAgent: "yarn/1.22.19 npm/? node/v22.0.0" })).toBe("yarn");
  });

  it("detects bun from the npm_config_user_agent", () => {
    expect(detectPackageManager({ userAgent: "bun/1.1.0 npm/? node/v22.0.0" })).toBe("bun");
  });

  it("detects npm from the npm_config_user_agent", () => {
    expect(detectPackageManager({ userAgent: "npm/10.0.0 node/v22.0.0" })).toBe("npm");
  });

  it("falls back to the exec path when the user agent is absent (pnpm)", () => {
    expect(
      detectPackageManager({
        execPath: "/Users/x/Library/pnpm/global/5/node_modules/.bin/council",
      }),
    ).toBe("pnpm");
  });

  it("falls back to the exec path when the user agent is absent (yarn)", () => {
    expect(detectPackageManager({ execPath: "/usr/local/yarn/bin/council" })).toBe("yarn");
  });

  it("falls back to the exec path when the user agent is absent (bun)", () => {
    expect(detectPackageManager({ execPath: "/Users/x/.bun/bin/council" })).toBe("bun");
  });

  it("defaults to npm when nothing is detected", () => {
    expect(detectPackageManager({})).toBe("npm");
    expect(detectPackageManager({ userAgent: "", execPath: "/usr/local/bin/council" })).toBe("npm");
  });

  it("prefers the user agent over the exec path", () => {
    expect(
      detectPackageManager({ userAgent: "pnpm/9.0.0", execPath: "/usr/local/yarn/bin/council" }),
    ).toBe("pnpm");
  });
});

describe("isPackageManager", () => {
  it("accepts the allow-listed managers", () => {
    for (const pm of ["npm", "pnpm", "yarn", "bun"]) {
      expect(isPackageManager(pm)).toBe(true);
    }
  });

  it("rejects anything outside the allow-list", () => {
    for (const bogus of ["rm -rf /", "npm; echo hi", "NPM", "deno", "", "pip"]) {
      expect(isPackageManager(bogus)).toBe(false);
    }
  });
});

describe("buildUpgradeArgs", () => {
  const cases: readonly (readonly [PackageManager, readonly string[]])[] = [
    ["npm", ["install", "-g", "council-ai@latest"]],
    ["pnpm", ["add", "-g", "council-ai@latest"]],
    ["yarn", ["global", "add", "council-ai@latest"]],
    ["bun", ["add", "-g", "council-ai@latest"]],
  ];

  for (const [pm, expected] of cases) {
    it(`maps ${pm} to its global-install argv`, () => {
      expect(buildUpgradeArgs(pm)).toEqual(expected);
    });
  }

  it("never embeds a shell string (each token is a separate arg)", () => {
    for (const [pm] of cases) {
      const args = buildUpgradeArgs(pm);
      for (const token of args) {
        expect(token).not.toMatch(/\s/);
      }
      expect(args).toContain("council-ai@latest");
    }
  });
});

describe("council update — command behavior", () => {
  it("rejects an invalid --pm value without running anything", async () => {
    const runner = okRunner();
    const fetchLatest = vi.fn(async () => "9.9.9");
    const { stderr, error } = await runUpdate(["--pm", "deno"], {
      runner,
      fetchLatest,
      currentVersion: "0.1.0",
    });
    expect(stderr).toMatch(/package manager/i);
    expect(error).toBeInstanceOf(Error);
    expect(runner).not.toHaveBeenCalled();
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it("honors an explicit valid --pm override", async () => {
    const runner = okRunner();
    const { stdout } = await runUpdate(["--pm", "yarn", "--yes"], {
      runner,
      fetchLatest: vi.fn(async () => "0.2.0"),
      currentVersion: "0.1.0",
    });
    expect(runner).toHaveBeenCalledWith("yarn", ["global", "add", "council-ai@latest"]);
    expect(stdout).toMatch(/Updated/);
  });

  it("short-circuits when already up to date and never runs the package manager", async () => {
    const runner = okRunner();
    const { stdout } = await runUpdate([], {
      runner,
      fetchLatest: vi.fn(async () => "0.2.0"),
      currentVersion: "0.2.0",
    });
    expect(stdout).toMatch(/already up to date/i);
    expect(stdout).toMatch(/0\.2\.0/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("prints a friendly notice and does not run when the latest version is unknown", async () => {
    const runner = okRunner();
    const { stderr } = await runUpdate([], {
      runner,
      fetchLatest: vi.fn(async () => null),
      currentVersion: "0.1.0",
    });
    expect(stderr).toMatch(/could ?n.t check/i);
    expect(runner).not.toHaveBeenCalled();
  });

  it("--dry-run prints the exact command and does not execute", async () => {
    const runner = okRunner();
    const { stdout } = await runUpdate(["--dry-run"], {
      runner,
      fetchLatest: vi.fn(async () => "0.2.0"),
      currentVersion: "0.1.0",
      execPath: "/usr/local/bin/council",
    });
    expect(stdout).toMatch(/npm install -g council-ai@latest/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("aborts without running when the user declines the confirmation", async () => {
    const runner = okRunner();
    const confirm = vi.fn(async () => false);
    const { stderr } = await runUpdate([], {
      runner,
      fetchLatest: vi.fn(async () => "0.2.0"),
      currentVersion: "0.1.0",
      confirmProvider: () => ({ confirm }),
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(runner).not.toHaveBeenCalled();
    expect(stderr).toMatch(/abort/i);
  });

  it("runs the upgrade and prints old→new on confirm", async () => {
    const runner = okRunner();
    const confirm = vi.fn(async () => true);
    const { stdout } = await runUpdate([], {
      runner,
      fetchLatest: vi.fn(async () => "0.2.0"),
      currentVersion: "0.1.0",
      confirmProvider: () => ({ confirm }),
      execPath: "/usr/local/bin/council",
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith("npm", ["install", "-g", "council-ai@latest"]);
    expect(stdout).toMatch(/0\.1\.0/);
    expect(stdout).toMatch(/0\.2\.0/);
    expect(stdout).toMatch(/restart council/i);
  });

  it("--yes skips the prompt and runs immediately", async () => {
    const runner = okRunner();
    const confirm = vi.fn(async () => false);
    const { stdout } = await runUpdate(["--yes"], {
      runner,
      fetchLatest: vi.fn(async () => "0.2.0"),
      currentVersion: "0.1.0",
      confirmProvider: () => ({ confirm }),
      execPath: "/usr/local/bin/council",
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(runner).toHaveBeenCalledOnce();
    expect(stdout).toMatch(/Updated/);
  });

  it("surfaces the package manager's stderr and exits non-zero on a failed run", async () => {
    const runner: UpgradeRunner = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "EACCES: permission denied",
    }));
    const { stderr, error } = await runUpdate(["--yes"], {
      runner,
      fetchLatest: vi.fn(async () => "0.2.0"),
      currentVersion: "0.1.0",
      execPath: "/usr/local/bin/council",
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(stderr).toMatch(/EACCES: permission denied/);
    expect(error).toBeInstanceOf(Error);
  });

  it("surfaces a spawn failure (runner rejection) as an error", async () => {
    const runner: UpgradeRunner = vi.fn(async () => {
      throw new Error("spawn npm ENOENT");
    });
    const { stderr, error } = await runUpdate(["--yes"], {
      runner,
      fetchLatest: vi.fn(async () => "0.2.0"),
      currentVersion: "0.1.0",
      execPath: "/usr/local/bin/council",
    });
    expect(stderr).toMatch(/ENOENT/);
    expect(error).toBeInstanceOf(Error);
  });

  it("exits with a non-zero network error code when the registry is unreachable", async () => {
    const runner = okRunner();
    const { stderr, error } = await runUpdate([], {
      runner,
      fetchLatest: vi.fn(async () => null),
      currentVersion: "0.1.0",
    });
    expect(stderr).toMatch(/could ?n.t check/i);
    expect(runner).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(CliUserError);
    expect((error as CliUserError).exitCode).toBe(EXIT_NETWORK_ERROR);
  });

  it("reports a timeout distinctly and keeps the captured output", async () => {
    const runner: UpgradeRunner = vi.fn(async () => ({
      kind: "timeout",
      stdout: "fetching packages...",
      stderr: "still installing",
    }));
    const { stderr, error } = await runUpdate(["--yes"], {
      runner,
      fetchLatest: vi.fn(async () => "0.2.0"),
      currentVersion: "0.1.0",
      execPath: "/usr/local/bin/council",
    });
    expect(stderr).toMatch(/timed out/i);
    expect(stderr).not.toMatch(/not installed/i);
    expect(stderr).toMatch(/still installing|fetching packages/);
    expect(error).toBeInstanceOf(Error);
  });

  it("classifies a signal kill (not 'not installed') and keeps the captured output", async () => {
    const runner: UpgradeRunner = vi.fn(async () => ({
      kind: "signal",
      signal: "SIGKILL",
      stdout: "",
      stderr: "child was killed",
    }));
    const { stderr, error } = await runUpdate(["--yes"], {
      runner,
      fetchLatest: vi.fn(async () => "0.2.0"),
      currentVersion: "0.1.0",
      execPath: "/usr/local/bin/council",
    });
    expect(stderr).toMatch(/signal/i);
    expect(stderr).toMatch(/SIGKILL/);
    expect(stderr).not.toMatch(/not installed/i);
    expect(stderr).toMatch(/child was killed/);
    expect(error).toBeInstanceOf(Error);
  });

  it("classifies a maxBuffer overflow and keeps the captured output", async () => {
    const runner: UpgradeRunner = vi.fn(async () => ({
      kind: "maxBuffer",
      stdout: "lots of progress output",
      stderr: "",
    }));
    const { stderr, error } = await runUpdate(["--yes"], {
      runner,
      fetchLatest: vi.fn(async () => "0.2.0"),
      currentVersion: "0.1.0",
      execPath: "/usr/local/bin/council",
    });
    expect(stderr).toMatch(/output/i);
    expect(stderr).not.toMatch(/not installed/i);
    expect(stderr).toMatch(/lots of progress output/);
    expect(error).toBeInstanceOf(Error);
  });

  it("sanitizes subprocess output with control bytes before displaying it", async () => {
    // A hostile package-manager transcript: OSC title-set + BEL, a real error
    // line, a CSI screen-clear introducing a forged "success" line, a C1 CSI
    // introducer (0x9B), a CR, and a Bidi override (Trojan Source, CVE-2021-42574).
    const hostile =
      "\x1b]0;pwned\x07real-error\n\x1b[2Jfake-success\x9b31m\r\u202Egnisrever";
    const runner: UpgradeRunner = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: hostile,
    }));
    const { stderr, error } = await runUpdate(["--yes"], {
      runner,
      fetchLatest: vi.fn(async () => "0.2.0"),
      currentVersion: "0.1.0",
      execPath: "/usr/local/bin/council",
    });

    // No raw terminal-control bytes survive to the writer.
    expect(stderr).not.toContain("\x1b");
    expect(stderr).not.toContain("\x07");
    expect(stderr).not.toContain("\x9b");
    expect(stderr).not.toContain("\u202e");

    // The surfaced detail is collapsed onto a SINGLE line so multi-line output
    // cannot forge terminal structure (e.g. a fake "success" line beneath the
    // real error). The writer output is "Error: ... failed:\n<detail>\n".
    const lines = stderr.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    const detail = lines[1];
    expect(detail).not.toMatch(/[\r\n]/);
    expect(detail).toContain("real-error");
    expect(detail).toContain("fake-success");

    expect(error).toBeInstanceOf(Error);
  });

  it("surfaces legitimate plain output unchanged (modulo newline normalization)", async () => {
    const runner: UpgradeRunner = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "npm ERR! code E404",
    }));
    const { stderr } = await runUpdate(["--yes"], {
      runner,
      fetchLatest: vi.fn(async () => "0.2.0"),
      currentVersion: "0.1.0",
      execPath: "/usr/local/bin/council",
    });
    expect(stderr).toContain("npm ERR! code E404");
  });
});

describe("classifyExecFileResult", () => {
  it("treats a null error as a clean exit", () => {
    expect(classifyExecFileResult(null, "ok", "")).toEqual({
      kind: "exit",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
  });

  it("maps a numeric error code to a non-zero exit", () => {
    const err = Object.assign(new Error("Command failed"), { code: 1 });
    expect(classifyExecFileResult(err, "", "EACCES")).toEqual({
      kind: "exit",
      exitCode: 1,
      stdout: "",
      stderr: "EACCES",
    });
  });

  it("classifies a maxBuffer overflow by its error code", () => {
    const err = Object.assign(new Error("stdout maxBuffer length exceeded"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      killed: true,
      signal: "SIGTERM",
    });
    expect(classifyExecFileResult(err, "huge", "")).toEqual({
      kind: "maxBuffer",
      stdout: "huge",
      stderr: "",
    });
  });

  it("classifies a parent-initiated kill (timeout) when killed is true", () => {
    const err = Object.assign(new Error("Command failed"), {
      code: null,
      signal: "SIGTERM",
      killed: true,
    });
    expect(classifyExecFileResult(err, "partial", "")).toEqual({
      kind: "timeout",
      stdout: "partial",
      stderr: "",
    });
  });

  it("classifies an external signal kill when killed is false", () => {
    const err = Object.assign(new Error("Command failed"), {
      code: null,
      signal: "SIGKILL",
      killed: false,
    });
    expect(classifyExecFileResult(err, "", "boom")).toEqual({
      kind: "signal",
      signal: "SIGKILL",
      stdout: "",
      stderr: "boom",
    });
  });

  it("throws a spawn failure (ENOENT) so callers can report 'not installed'", () => {
    const err = Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
    expect(() => classifyExecFileResult(err, "", "")).toThrow(/ENOENT/);
  });
});
