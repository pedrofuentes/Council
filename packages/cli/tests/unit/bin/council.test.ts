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
        "chcp.com",
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
        "chcp.com",
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

    it("does not launch the TUI when COUNCIL_TUI is unset", async () => {
      const { maybeLaunchTui } = await loadCouncilModule();
      let launched = 0;
      const result = await maybeLaunchTui({
        argv: ["node", "council"],
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
