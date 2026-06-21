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

function createWritable(
  target: string,
  calls: WriteCall[],
  isTTY?: boolean,
): TestWritable {
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
      expect(commandNames[1]).toBe("config");
      expect(commandNames[2]).toBe("telemetry");
      expect(commandNames[3]).toBe("docs");
      expect(commandNames[4]).toBe("update");

      // Deliberation
      expect(commandNames[5]).toBe("convene");
      expect(commandNames[6]).toBe("resume");
      expect(commandNames[7]).toBe("conclude");

      // Conversation
      expect(commandNames[8]).toBe("ask");
      expect(commandNames[9]).toBe("chat");

      // Library
      expect(commandNames[10]).toBe("expert");
      expect(commandNames[11]).toBe("panel");
      expect(commandNames[12]).toBe("templates");

      // Inspection
      expect(commandNames[13]).toBe("sessions");
      expect(commandNames[14]).toBe("memory");
      expect(commandNames[15]).toBe("export");

      // Other commands (not in categories but registered)
      expect(commandNames[16]).toBe("models");
    });
  });
});
