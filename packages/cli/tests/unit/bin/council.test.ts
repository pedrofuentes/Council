import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import councilPackageJson from "../../../package.json" with { type: "json" };
import type { MaybeNotifyUpdateOptions } from "../../../src/core/version/index.js";

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

  describe("command placement under section headers (#681)", () => {
    // Mirror of COMMAND_CATEGORIES in src/bin/council.ts: each rendered section
    // label paired with the commands that must appear beneath it, in order.
    const EXPECTED_SECTIONS: readonly (readonly [string, readonly string[]])[] = [
      ["Getting Started", ["doctor", "demo", "config", "telemetry", "docs", "update", "ui"]],
      ["Deliberation", ["convene", "resume", "conclude", "review"]],
      ["Conversation", ["ask", "chat"]],
      ["Library", ["expert", "panel", "templates"]],
      ["Inspection", ["sessions", "memory", "export"]],
    ];

    async function renderHelpLines(): Promise<string[]> {
      const { buildProgram } = await loadCouncilModule();
      return buildProgram().helpInformation().split("\n");
    }

    function headerIndex(lines: readonly string[], label: string): number {
      return lines.findIndex((line) => line === `${label}:`);
    }

    // Index of the rendered line whose first token is `command` (2-space
    // indented under a section), searched within the half-open [from, to) range.
    function commandLineIndex(
      lines: readonly string[],
      command: string,
      from: number,
      to: number,
    ): number {
      for (let i = from; i < to; i += 1) {
        if (new RegExp(`^\\s+${command}\\b`).test(lines[i] ?? "")) {
          return i;
        }
      }
      return -1;
    }

    it("renders each command between its own section header and the next section", async () => {
      const lines = await renderHelpLines();

      EXPECTED_SECTIONS.forEach(([label, commands], sectionIdx) => {
        const start = headerIndex(lines, label);
        expect(start, `"${label}:" header missing`).toBeGreaterThanOrEqual(0);

        const nextLabel = EXPECTED_SECTIONS[sectionIdx + 1]?.[0];
        const end = nextLabel === undefined ? lines.length : headerIndex(lines, nextLabel);
        expect(end, `"${label}" section is not before the following section`).toBeGreaterThan(
          start,
        );

        let previousIdx = start;
        for (const command of commands) {
          const idx = commandLineIndex(lines, command, start + 1, end);
          expect(idx, `"${command}" not listed under "${label}"`).toBeGreaterThan(start);
          expect(idx, `"${command}" listed past the "${label}" section`).toBeLessThan(end);
          expect(idx, `"${command}" out of order under "${label}"`).toBeGreaterThan(previousIdx);
          previousIdx = idx;
        }
      });
    });

    it("keeps every command out of foreign section blocks (inverse)", async () => {
      const lines = await renderHelpLines();

      const bounds = EXPECTED_SECTIONS.map(([label], idx) => {
        const start = headerIndex(lines, label);
        const nextLabel = EXPECTED_SECTIONS[idx + 1]?.[0];
        const end = nextLabel === undefined ? lines.length : headerIndex(lines, nextLabel);
        return { label, start, end };
      });

      EXPECTED_SECTIONS.forEach(([ownLabel, commands]) => {
        for (const command of commands) {
          for (const { label, start, end } of bounds) {
            const present = commandLineIndex(lines, command, start + 1, end) >= 0;
            if (label === ownLabel) {
              expect(present, `"${command}" should appear under "${label}"`).toBe(true);
            } else {
              expect(present, `"${command}" must not appear under "${label}"`).toBe(false);
            }
          }
        }
      });
    });

    it("orders the section headers as documented", async () => {
      const lines = await renderHelpLines();
      let previous = -1;
      for (const [label] of EXPECTED_SECTIONS) {
        const idx = headerIndex(lines, label);
        expect(idx, `"${label}:" header missing`).toBeGreaterThanOrEqual(0);
        expect(idx, `"${label}:" header out of documented order`).toBeGreaterThan(previous);
        previous = idx;
      }
    });

    it("places the getting-started hint after the final Inspection command", async () => {
      const lines = await renderHelpLines();
      const inspectionStart = headerIndex(lines, "Inspection");
      const exportIdx = commandLineIndex(lines, "export", inspectionStart + 1, lines.length);
      const hintIdx = lines.findIndex(
        (line) => line === "New to Council? Start with: council doctor",
      );

      expect(exportIdx).toBeGreaterThan(inspectionStart);
      expect(hintIdx).toBeGreaterThan(exportIdx);
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

describe("resolveUpdateNoticeQuiet (#1286)", () => {
  it("is not quiet when neither the parsed state nor argv requests it (inverse)", async () => {
    const { resolveUpdateNoticeQuiet } = await loadCouncilModule();
    expect(resolveUpdateNoticeQuiet(["node", "council", "doctor"], false)).toBe(false);
  });

  it("is quiet when the parsed --quiet state is set, even without an argv flag", async () => {
    const { resolveUpdateNoticeQuiet } = await loadCouncilModule();
    expect(resolveUpdateNoticeQuiet(["node", "council", "doctor"], true)).toBe(true);
  });

  it("is quiet when argv carries --quiet even if the parsed state is false", async () => {
    const { resolveUpdateNoticeQuiet } = await loadCouncilModule();
    expect(
      resolveUpdateNoticeQuiet(["node", "council", "convene", "topic", "--quiet"], false),
    ).toBe(true);
  });

  it("is quiet when argv carries the -q short flag even if the parsed state is false", async () => {
    const { resolveUpdateNoticeQuiet } = await loadCouncilModule();
    expect(resolveUpdateNoticeQuiet(["node", "council", "convene", "topic", "-q"], false)).toBe(
      true,
    );
  });

  it("matches the quiet flags by exact token, not as a substring (discriminating)", async () => {
    const { resolveUpdateNoticeQuiet } = await loadCouncilModule();
    // A lookalike flag or a bare positional must never trip quiet mode.
    expect(resolveUpdateNoticeQuiet(["node", "council", "ask", "--quiets"], false)).toBe(false);
    expect(resolveUpdateNoticeQuiet(["node", "council", "ask", "-quiet"], false)).toBe(false);
    expect(resolveUpdateNoticeQuiet(["node", "council", "ask", "quiet"], false)).toBe(false);
  });
});

describe("runCli update-notice wiring (#1286)", () => {
  async function runCliCapturingNotice(input: {
    readonly argv: readonly string[];
    readonly launched: boolean;
    readonly stderrIsTTY: boolean;
  }): Promise<MaybeNotifyUpdateOptions[]> {
    const { runCli } = await loadCouncilModule();
    const captured: MaybeNotifyUpdateOptions[] = [];
    await runCli({
      argv: input.argv,
      launchTuiGuard: async () => input.launched,
      parseProgram: async () => undefined,
      notifyUpdate: async (options) => {
        captured.push(options);
      },
      stderrIsTTY: input.stderrIsTTY,
    });
    return captured;
  }

  it("invokes the notifier once with the resolved args on the CLI (non-quiet) path", async () => {
    const captured = await runCliCapturingNotice({
      argv: ["node", "council", "doctor"],
      launched: false,
      stderrIsTTY: true,
    });
    expect(captured).toEqual([
      { currentVersion: councilPackageJson.version, isTTY: true, quiet: false },
    ]);
  });

  it("passes quiet:true to the notifier when --quiet is in argv", async () => {
    const captured = await runCliCapturingNotice({
      argv: ["node", "council", "convene", "topic", "--quiet"],
      launched: false,
      stderrIsTTY: true,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.quiet).toBe(true);
  });

  it("passes quiet:true to the notifier when the -q short flag is in argv", async () => {
    const captured = await runCliCapturingNotice({
      argv: ["node", "council", "convene", "topic", "-q"],
      launched: false,
      stderrIsTTY: true,
    });
    expect(captured[0]?.quiet).toBe(true);
  });

  it("threads the stderr TTY state through to the notifier (isTTY:false)", async () => {
    const captured = await runCliCapturingNotice({
      argv: ["node", "council", "doctor"],
      launched: false,
      stderrIsTTY: false,
    });
    expect(captured[0]?.isTTY).toBe(false);
  });

  it("still invokes the notifier with correct args when parsing throws (error path)", async () => {
    const { runCli } = await loadCouncilModule();
    // Import CliUserError from the same post-reset module graph as runCli so
    // `instanceof` holds inside handleCliError and the error path stays silent.
    const { CliUserError } = await import("../../../src/cli/cli-user-error.js");
    const captured: MaybeNotifyUpdateOptions[] = [];
    const previousExitCode = process.exitCode;

    try {
      await expect(
        runCli({
          argv: ["node", "council", "doctor"],
          launchTuiGuard: async () => false,
          parseProgram: async () => {
            throw new CliUserError("boom");
          },
          notifyUpdate: async (options) => {
            captured.push(options);
          },
          stderrIsTTY: true,
        }),
      ).resolves.toBeUndefined();

      // The finally-block notifier runs even though parsing rejected.
      expect(captured).toEqual([
        { currentVersion: councilPackageJson.version, isTTY: true, quiet: false },
      ]);
      // The thrown CliUserError was handled (mapped to the user-error exit code),
      // proving the notifier fired from the catch/finally path, not a clean exit.
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("does not invoke the notifier on the TUI-launch path", async () => {
    const captured = await runCliCapturingNotice({
      argv: ["node", "council"],
      launched: true,
      stderrIsTTY: true,
    });
    expect(captured).toEqual([]);
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
        // Restore exactly the four env vars this test mutates. Static member
        // deletes keep ESLint's no-dynamic-delete rule satisfied.
        if (origEnv.CI === undefined) delete process.env.CI;
        else process.env.CI = origEnv.CI;
        if (origEnv.COUNCIL_NO_TUI === undefined) delete process.env.COUNCIL_NO_TUI;
        else process.env.COUNCIL_NO_TUI = origEnv.COUNCIL_NO_TUI;
        if (origEnv.COUNCIL_TUI === undefined) delete process.env.COUNCIL_TUI;
        else process.env.COUNCIL_TUI = origEnv.COUNCIL_TUI;
        if (origEnv.COUNCIL_SQLITE_WARNING_REEXEC === undefined)
          delete process.env.COUNCIL_SQLITE_WARNING_REEXEC;
        else process.env.COUNCIL_SQLITE_WARNING_REEXEC = origEnv.COUNCIL_SQLITE_WARNING_REEXEC;
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
