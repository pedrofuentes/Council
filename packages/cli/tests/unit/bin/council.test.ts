import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

interface WriteCall {
  readonly target: string;
  readonly chunk: string;
  readonly encoding: BufferEncoding | undefined;
}

interface TestWritable {
  readonly isTTY?: boolean;
  write(
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    cb?: (error?: Error | null) => void,
  ): boolean;
}

async function loadCouncilModule() {
  return import("../../../src/bin/council.js");
}

async function loadUiCommandModule() {
  return import("../../../src/cli/commands/ui.js");
}

function createWritable(target: string, calls: WriteCall[], isTTY?: boolean): TestWritable {
  return {
    isTTY,
    write: (
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      cb?: (error?: Error | null) => void,
    ): boolean => {
      calls.push({
        target,
        chunk: typeof chunk === "string" ? chunk : chunk.toString("utf8"),
        encoding: typeof encoding === "string" ? encoding : undefined,
      });

      if (typeof encoding === "function") {
        encoding(null);
      }
      cb?.(null);
      return true;
    },
  };
}

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.doUnmock("../../../src/bin/sqlite-warning-filter.js");
  vi.doUnmock("../../../src/tui/index.js");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("buildProgram", () => {
  describe("Windows UTF-8 output", () => {
    it("switches Windows TTY output to the UTF-8 console code page before wrapping writes", async () => {
      const execFileSync = vi.fn().mockReturnValue(Buffer.alloc(0));
      vi.doMock("node:child_process", () => ({ execFileSync }));

      const { configureOutputEncoding } = await loadCouncilModule();
      execFileSync.mockClear();

      const calls: WriteCall[] = [];
      const stdout = createWritable("stdout", calls, true);
      const stderr = createWritable("stderr", calls, true);

      configureOutputEncoding("win32", stdout, stderr);
      stdout.write("stdout — 2× ≥ 🎉");
      stderr.write("stderr — 2× ≥ 🎉");

      expect(execFileSync).toHaveBeenCalledOnce();
      expect(execFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/[\\/]System32[\\/]chcp\.com$/i),
        ["65001"],
        expect.objectContaining({ stdio: "ignore", windowsHide: true }),
      );
      expect(calls).toEqual([
        { target: "stdout", chunk: "stdout — 2× ≥ 🎉", encoding: "utf8" },
        { target: "stderr", chunk: "stderr — 2× ≥ 🎉", encoding: "utf8" },
      ]);
    });

    it("switches the Windows console code page when stdout is piped but stderr is a TTY", async () => {
      const execFileSync = vi.fn().mockReturnValue(Buffer.alloc(0));
      vi.doMock("node:child_process", () => ({ execFileSync }));

      const { configureOutputEncoding } = await loadCouncilModule();
      execFileSync.mockClear();

      const calls: WriteCall[] = [];
      const stdout = createWritable("stdout", calls, false);
      const stderr = createWritable("stderr", calls, true);

      configureOutputEncoding("win32", stdout, stderr);
      stdout.write("stdout — 2× ≥ 🎉");
      stderr.write("stderr — 2× ≥ 🎉");

      expect(execFileSync).toHaveBeenCalledOnce();
      expect(execFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/[\\/]System32[\\/]chcp\.com$/i),
        ["65001"],
        expect.objectContaining({ stdio: "ignore", windowsHide: true }),
      );
      expect(calls).toEqual([
        { target: "stdout", chunk: "stdout — 2× ≥ 🎉", encoding: undefined },
        { target: "stderr", chunk: "stderr — 2× ≥ 🎉", encoding: "utf8" },
      ]);
    });

    it("only switches the Windows console code page once for the same stdout stream", async () => {
      const execFileSync = vi.fn().mockReturnValue(Buffer.alloc(0));
      vi.doMock("node:child_process", () => ({ execFileSync }));

      const { configureOutputEncoding } = await loadCouncilModule();
      execFileSync.mockClear();

      const calls: WriteCall[] = [];
      const stdout = createWritable("stdout", calls, true);
      const stderr = createWritable("stderr", calls, true);

      configureOutputEncoding("win32", stdout, stderr);
      configureOutputEncoding("win32", stdout, stderr);
      stdout.write("stdout — 2× ≥ 🎉");
      stderr.write("stderr — 2× ≥ 🎉");

      expect(execFileSync).toHaveBeenCalledOnce();
      expect(calls).toEqual([
        { target: "stdout", chunk: "stdout — 2× ≥ 🎉", encoding: "utf8" },
        { target: "stderr", chunk: "stderr — 2× ≥ 🎉", encoding: "utf8" },
      ]);
    });

    it("degrades gracefully when switching the Windows console code page fails", async () => {
      const execFileSync = vi.fn().mockImplementation(() => {
        throw new Error("chcp failed");
      });
      vi.doMock("node:child_process", () => ({ execFileSync }));

      const { configureOutputEncoding } = await loadCouncilModule();
      execFileSync.mockClear();

      const calls: WriteCall[] = [];
      const stdout = createWritable("stdout", calls, true);
      const stderr = createWritable("stderr", calls, true);

      expect(() => configureOutputEncoding("win32", stdout, stderr)).not.toThrow();
      stdout.write("stdout — 2× ≥ 🎉");
      stderr.write("stderr — 2× ≥ 🎉");

      expect(execFileSync).toHaveBeenCalledOnce();
      expect(calls).toEqual([
        { target: "stdout", chunk: "stdout — 2× ≥ 🎉", encoding: "utf8" },
        { target: "stderr", chunk: "stderr — 2× ≥ 🎉", encoding: "utf8" },
      ]);
    });

    it("skips output encoding changes on non-Windows platforms", async () => {
      const execFileSync = vi.fn().mockReturnValue(Buffer.alloc(0));
      vi.doMock("node:child_process", () => ({ execFileSync }));

      const { configureOutputEncoding } = await loadCouncilModule();
      execFileSync.mockClear();

      const calls: WriteCall[] = [];
      const stdout = createWritable("stdout", calls, true);
      const stderr = createWritable("stderr", calls, true);

      configureOutputEncoding("linux", stdout, stderr);
      stdout.write("stdout — 2× ≥ 🎉");
      stderr.write("stderr — 2× ≥ 🎉");

      expect(execFileSync).not.toHaveBeenCalled();
      expect(calls).toEqual([
        { target: "stdout", chunk: "stdout — 2× ≥ 🎉", encoding: undefined },
        { target: "stderr", chunk: "stderr — 2× ≥ 🎉", encoding: undefined },
      ]);
    });
  });

  describe("help output grouping", () => {
    it("includes Getting Started section header", async () => {
      const { buildProgram } = await loadCouncilModule();
      const program = buildProgram();
      const help = program.helpInformation();

      expect(help).toContain("Getting Started:");
    });

    it("includes Deliberation section header", async () => {
      const { buildProgram } = await loadCouncilModule();
      const program = buildProgram();
      const help = program.helpInformation();

      expect(help).toContain("Deliberation:");
    });

    it("includes Conversation section header", async () => {
      const { buildProgram } = await loadCouncilModule();
      const program = buildProgram();
      const help = program.helpInformation();

      expect(help).toContain("Conversation:");
    });

    it("includes Library section header", async () => {
      const { buildProgram } = await loadCouncilModule();
      const program = buildProgram();
      const help = program.helpInformation();

      expect(help).toContain("Library:");
    });

    it("includes Inspection section header", async () => {
      const { buildProgram } = await loadCouncilModule();
      const program = buildProgram();
      const help = program.helpInformation();

      expect(help).toContain("Inspection:");
    });

    it("includes getting-started hint at end", async () => {
      const { buildProgram } = await loadCouncilModule();
      const program = buildProgram();
      const help = program.helpInformation();

      expect(help).toContain("New to Council? Start with: council doctor");
    });

    it("lists doctor first in command list", async () => {
      const { buildProgram } = await loadCouncilModule();
      const program = buildProgram();
      const commandNames = program.commands.map((cmd) => cmd.name());

      expect(commandNames[0]).toBe("doctor");
    });

    it("groups commands in correct order", async () => {
      const { buildProgram } = await loadCouncilModule();
      const program = buildProgram();
      const commandNames = program.commands.map((cmd) => cmd.name());

      // Getting Started
      expect(commandNames[0]).toBe("doctor");
      expect(commandNames[1]).toBe("demo");
      expect(commandNames[2]).toBe("config");
      expect(commandNames[3]).toBe("telemetry");
      expect(commandNames[4]).toBe("docs");
      expect(commandNames[5]).toBe("update");
      expect(commandNames[6]).toBe("ui");

      // Deliberation
      expect(commandNames[7]).toBe("convene");
      expect(commandNames[8]).toBe("resume");
      expect(commandNames[9]).toBe("conclude");
      expect(commandNames[10]).toBe("review");

      // Conversation
      expect(commandNames[11]).toBe("ask");
      expect(commandNames[12]).toBe("chat");

      // Library
      expect(commandNames[13]).toBe("expert");
      expect(commandNames[14]).toBe("panel");
      expect(commandNames[15]).toBe("templates");

      // Inspection
      expect(commandNames[16]).toBe("sessions");
      expect(commandNames[17]).toBe("memory");
      expect(commandNames[18]).toBe("export");

      // Other commands (not in categories but registered)
      expect(commandNames[19]).toBe("models");
    });
  });

  describe("TUI entry guard", () => {
    it("does not interfere with subcommand execution", async () => {
      const { buildProgram } = await loadCouncilModule();
      const program = buildProgram();
      const commands = program.commands.map((c) => c.name());
      // Ensure all commands are still registered despite the TUI entry guard
      expect(commands).toContain("doctor");
      expect(commands).toContain("convene");
      expect(commands).toContain("chat");
    });

    it("launches the TUI and signals skip-parse when the guard passes", async () => {
      const { maybeLaunchTui } = await loadCouncilModule();
      let launched = 0;
      const result = await maybeLaunchTui({
        argv: ["node", "council"],
        stdout: { isTTY: true },
        stdin: { isTTY: true },
        env: { COUNCIL_TUI: "1" },
        launchTui: async () => {
          launched += 1;
        },
      });
      expect(result).toBe(true);
      expect(launched).toBe(1);
    });

    it("does not launch the TUI for an explicit subcommand", async () => {
      const { maybeLaunchTui } = await loadCouncilModule();
      let launched = 0;
      const result = await maybeLaunchTui({
        argv: ["node", "council", "doctor"],
        stdout: { isTTY: true },
        env: { COUNCIL_TUI: "1" },
        launchTui: async () => {
          launched += 1;
        },
      });
      expect(result).toBe(false);
      expect(launched).toBe(0);
    });

    it("launches the TUI by default on a bare TTY invocation (COUNCIL_TUI unset)", async () => {
      const { maybeLaunchTui } = await loadCouncilModule();
      let launched = 0;
      const result = await maybeLaunchTui({
        argv: ["node", "council"],
        stdout: { isTTY: true },
        stdin: { isTTY: true },
        env: {},
        launchTui: async () => {
          launched += 1;
        },
      });
      expect(result).toBe(true);
      expect(launched).toBe(1);
    });

    it("does not launch the TUI when --no-tui is passed", async () => {
      const { maybeLaunchTui } = await loadCouncilModule();
      let launched = 0;
      const result = await maybeLaunchTui({
        argv: ["node", "council", "--no-tui"],
        stdout: { isTTY: true },
        env: {},
        launchTui: async () => {
          launched += 1;
        },
      });
      expect(result).toBe(false);
      expect(launched).toBe(0);
    });
  });
});

describe("buildUiCommand", () => {
  it("registers a 'ui' command that launches the interactive terminal UI", async () => {
    const { buildUiCommand } = await loadUiCommandModule();
    const cmd = buildUiCommand();
    expect(cmd.name()).toBe("ui");
    expect(cmd.description().toLowerCase()).toMatch(/launch|interactive|terminal ui|tui/);
  });

  it("invokes the injected TUI launcher exactly once when run", async () => {
    const { buildUiCommand } = await loadUiCommandModule();
    let launched = 0;
    const cmd = buildUiCommand({
      launchTui: async () => {
        launched += 1;
      },
    });
    cmd.exitOverride();
    await cmd.parseAsync(["node", "council-ui"]);
    expect(launched).toBe(1);
  });
});

describe("runCli update-notice suppression (#1691)", () => {
  it("skips the exit update notifier when the TUI launched", async () => {
    const { runCli } = await loadCouncilModule();
    let parsed = 0;
    let notified = 0;
    await runCli({
      argv: ["node", "council"],
      launchTuiGuard: async () => true,
      parseProgram: async () => {
        parsed += 1;
      },
      notifyUpdate: async () => {
        notified += 1;
      },
      stderrIsTTY: true,
    });
    // The TUI banner already surfaced the notice; the outer CLI notifier must
    // not re-emit it (and the CLI program is never parsed on the TUI path).
    expect(parsed).toBe(0);
    expect(notified).toBe(0);
  });

  it("still runs the exit update notifier on the CLI path", async () => {
    const { runCli } = await loadCouncilModule();
    let parsed = 0;
    let notified = 0;
    await runCli({
      argv: ["node", "council", "doctor"],
      launchTuiGuard: async () => false,
      parseProgram: async () => {
        parsed += 1;
      },
      notifyUpdate: async () => {
        notified += 1;
      },
      stderrIsTTY: true,
    });
    expect(parsed).toBe(1);
    expect(notified).toBe(1);
  });
});

describe("resolveWindowsCodePageCommand (#843)", () => {
  it("builds an absolute System32 path from %SystemRoot%", async () => {
    const { resolveWindowsCodePageCommand } = await loadCouncilModule();

    expect(resolveWindowsCodePageCommand({ SystemRoot: "D:\\Windows" })).toBe(
      "D:\\Windows\\System32\\chcp.com",
    );
  });

  it("falls back to the default Windows directory when %SystemRoot% is unset", async () => {
    const { resolveWindowsCodePageCommand } = await loadCouncilModule();

    expect(resolveWindowsCodePageCommand({})).toBe("C:\\Windows\\System32\\chcp.com");
  });

  it("falls back to the default Windows directory when %SystemRoot% is blank", async () => {
    const { resolveWindowsCodePageCommand } = await loadCouncilModule();

    expect(resolveWindowsCodePageCommand({ SystemRoot: "   " })).toBe(
      "C:\\Windows\\System32\\chcp.com",
    );
  });

  it("normalizes a trailing separator on %SystemRoot%", async () => {
    const { resolveWindowsCodePageCommand } = await loadCouncilModule();

    expect(resolveWindowsCodePageCommand({ SystemRoot: "C:\\Windows\\" })).toBe(
      "C:\\Windows\\System32\\chcp.com",
    );
  });

  it("never resolves the bare command name, defeating PATH shadowing", async () => {
    const { resolveWindowsCodePageCommand } = await loadCouncilModule();

    const resolved = resolveWindowsCodePageCommand({ SystemRoot: "C:\\Windows" });
    expect(resolved).not.toBe("chcp.com");
    expect(resolved).toMatch(/[\\/]System32[\\/]chcp\.com$/i);
  });
});

describe("startup entrypoint (isMainModule) (#796)", () => {
  // The bootstrap guard in council.ts recognizes itself as the program entry
  // only when its module URL matches `process.argv[1]` (source runs) or ends
  // with `/bin/council.js` (built dist). Under Vitest the source resolves to
  // `council.ts`, and the argv[1] match relies on POSIX-style `file://` URLs,
  // so this real-startup probe is exercised on POSIX CI shards; on Windows the
  // published `council.js` dist takes the `.js` suffix branch, which the e2e
  // bundled-binary smoke test covers instead.
  it.skipIf(process.platform === "win32")(
    "wraps the real startup output path with the absolute chcp command on Windows",
    async () => {
      const execFileSync = vi.fn().mockReturnValue(Buffer.alloc(0));
      const spawnSync = vi.fn().mockReturnValue({ status: 0 });
      const launchTui = vi.fn(async () => undefined);
      vi.doMock("node:child_process", () => ({ execFileSync, spawnSync }));
      vi.doMock("../../../src/bin/sqlite-warning-filter.js", () => ({
        installSqliteExperimentalWarningFilter: vi.fn(),
        installSqliteExperimentalWarningStderrFilter: vi.fn(),
      }));
      vi.doMock("../../../src/tui/index.js", () => ({ launchTui }));

      const councilPath = fileURLToPath(new URL("../../../src/bin/council.ts", import.meta.url));

      const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      const origArgv = process.argv;
      const origOutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      const origInTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      const origOutWrite = process.stdout.write.bind(process.stdout);
      const origEnv = { ...process.env };

      try {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
        delete process.env.CI;
        delete process.env.COUNCIL_NO_TUI;
        // Force the TUI-launch path so the fire-and-forget runCli() settles on
        // the mocked launcher instead of parsing argv (which would exit).
        process.env.COUNCIL_TUI = "1";
        // Keep the Windows re-exec guard from spawning/exiting during the probe.
        process.env.COUNCIL_SQLITE_WARNING_REEXEC = "1";
        process.argv = ["node", councilPath];

        await import("../../../src/bin/council.js");
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        process.stdout.write = origOutWrite;
        if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
        if (origOutTTY) Object.defineProperty(process.stdout, "isTTY", origOutTTY);
        else delete (process.stdout as { isTTY?: boolean }).isTTY;
        if (origInTTY) Object.defineProperty(process.stdin, "isTTY", origInTTY);
        else delete (process.stdin as { isTTY?: boolean }).isTTY;
        process.argv = origArgv;
        for (const key of Object.keys(process.env)) {
          if (!(key in origEnv)) delete process.env[key];
        }
        Object.assign(process.env, origEnv);
      }

      // Proves the real module-load path invoked configureOutputEncoding()
      // (the Windows console code-page switch) using the hardened absolute
      // command rather than the bare, PATH-resolved `chcp.com`.
      expect(execFileSync).toHaveBeenCalledTimes(1);
      expect(execFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/[\\/]System32[\\/]chcp\.com$/i),
        ["65001"],
        expect.objectContaining({ stdio: "ignore", windowsHide: true }),
      );
      // And that startup continued into runCli(), launching the (mocked) TUI.
      expect(launchTui).toHaveBeenCalledTimes(1);
    },
  );
});
