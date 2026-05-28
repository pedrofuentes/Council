import type { Command } from "commander";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildProgram, resetFirstRunSetupForTests, type BuildProgramOptions } from "../../../src/bin/council.js";
import { ConfigSchema } from "../../../src/config/index.js";

function createProbeProgram(
  options?: BuildProgramOptions,
  onAction: () => void = () => undefined,
): Command {
  const program = buildProgram(options);
  program.command("probe").action(onAction);
  return program;
}

function buildProgramWithStubbedAction(
  commandName: string,
  options: BuildProgramOptions,
  onAction: () => void = () => undefined,
): Command {
  const program = buildProgram(options);
  const cmd = program.commands.find((c) => c.name() === commandName);
  if (cmd === undefined) {
    throw new Error(`Subcommand ${commandName} not registered`);
  }
  cmd.action(onAction);
  return program;
}

describe("buildProgram first-run hook", () => {
  beforeEach(() => {
    resetFirstRunSetupForTests();
  });

  it("runs first-run setup before the subcommand action", async () => {
    const events: string[] = [];
    const loadConfigWithMeta = vi.fn(async () => ({
      config: ConfigSchema.parse({}),
      isFirstRun: true,
    }));
    const selectModelInteractively = vi.fn(async () => {
      events.push("select");
      return "claude-sonnet-4.5";
    });

    const program = createProbeProgram(
      {
        firstRunSetup: {
          loadConfigWithMeta,
          selectModelInteractively,
          write: () => undefined,
        },
      },
      () => {
        events.push("action");
      },
    );

    await program.parseAsync(["node", "council", "probe"]);

    expect(loadConfigWithMeta).toHaveBeenCalledTimes(1);
    expect(selectModelInteractively).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["select", "action"]);
  });

  it("skips selection when the config already exists", async () => {
    const loadConfigWithMeta = vi.fn(async () => ({
      config: ConfigSchema.parse({}),
      isFirstRun: false,
    }));
    const selectModelInteractively = vi.fn();
    const action = vi.fn();
    const program = createProbeProgram(
      {
        firstRunSetup: {
          loadConfigWithMeta,
          selectModelInteractively,
          write: () => undefined,
        },
      },
      action,
    );

    await program.parseAsync(["node", "council", "probe"]);

    expect(loadConfigWithMeta).toHaveBeenCalledTimes(1);
    expect(selectModelInteractively).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("preserves --quiet while the first-run hook executes", async () => {
    const loadConfigWithMeta = vi.fn(async () => ({
      config: ConfigSchema.parse({}),
      isFirstRun: false,
    }));
    const selectModelInteractively = vi.fn();
    let capturedQuiet: boolean | undefined;
    const program = createProbeProgram(
      {
        firstRunSetup: {
          loadConfigWithMeta,
          selectModelInteractively,
          write: () => undefined,
        },
      },
      () => {
        capturedQuiet = program.optsWithGlobals()["quiet"] as boolean | undefined;
      },
    );

    await program.parseAsync(["node", "council", "--quiet", "probe"]);

    expect(loadConfigWithMeta).toHaveBeenCalledTimes(1);
    expect(selectModelInteractively).not.toHaveBeenCalled();
    expect(capturedQuiet).toBe(true);
  });

  it("keeps default buildProgram parsing synchronous for --quiet", () => {
    let capturedQuiet: boolean | undefined;
    const program = createProbeProgram(undefined, () => {
      capturedQuiet = program.optsWithGlobals()["quiet"] as boolean | undefined;
    });

    program.parse(["node", "council", "--quiet", "probe"]);

    expect(capturedQuiet).toBe(true);
  });

  it("only performs first-run setup once per process", async () => {
    const loadConfigWithMeta = vi.fn(async () => ({
      config: ConfigSchema.parse({}),
      isFirstRun: true,
    }));
    const selectModelInteractively = vi.fn(async () => "claude-sonnet-4.5");

    const firstProgram = createProbeProgram({
      firstRunSetup: {
        loadConfigWithMeta,
        selectModelInteractively,
        write: () => undefined,
      },
    });
    const secondProgram = createProbeProgram({
      firstRunSetup: {
        loadConfigWithMeta,
        selectModelInteractively,
        write: () => undefined,
      },
    });

    await firstProgram.parseAsync(["node", "council", "probe"]);
    await secondProgram.parseAsync(["node", "council", "probe"]);

    expect(loadConfigWithMeta).toHaveBeenCalledTimes(1);
    expect(selectModelInteractively).toHaveBeenCalledTimes(1);
  });

  it("skips first-run setup for the doctor command", async () => {
    const loadConfigWithMeta = vi.fn(async () => ({
      config: ConfigSchema.parse({}),
      isFirstRun: true,
    }));
    const selectModelInteractively = vi.fn(async () => "claude-sonnet-4.5");
    const action = vi.fn();

    const program = buildProgramWithStubbedAction(
      "doctor",
      {
        firstRunSetup: {
          loadConfigWithMeta,
          selectModelInteractively,
          write: () => undefined,
        },
      },
      action,
    );

    await program.parseAsync(["node", "council", "doctor"]);

    expect(action).toHaveBeenCalledTimes(1);
    expect(loadConfigWithMeta).not.toHaveBeenCalled();
    expect(selectModelInteractively).not.toHaveBeenCalled();
  });

  it("skips first-run setup for the config command (including subcommands)", async () => {
    const loadConfigWithMeta = vi.fn(async () => ({
      config: ConfigSchema.parse({}),
      isFirstRun: true,
    }));
    const selectModelInteractively = vi.fn(async () => "claude-sonnet-4.5");
    const action = vi.fn();

    const program = buildProgram({
      firstRunSetup: {
        loadConfigWithMeta,
        selectModelInteractively,
        write: () => undefined,
      },
    });
    const configCmd = program.commands.find((c) => c.name() === "config");
    if (configCmd === undefined) throw new Error("config command not registered");
    const showCmd = configCmd.commands.find((c) => c.name() === "show");
    if (showCmd === undefined) throw new Error("config show subcommand not registered");
    showCmd.action(action);

    await program.parseAsync(["node", "council", "config", "show"]);

    expect(action).toHaveBeenCalledTimes(1);
    expect(loadConfigWithMeta).not.toHaveBeenCalled();
    expect(selectModelInteractively).not.toHaveBeenCalled();
  });
});

describe("unknown option handling", () => {
  it("rejects unknown global flags", async () => {
    const program = createProbeProgram();
    program.exitOverride();
    await expect(program.parseAsync(["node", "council", "--foobar", "probe"])).rejects.toThrow(/unknown option/);
  });

  it("rejects unknown subcommand flags", async () => {
    const program = buildProgram();
    program.exitOverride();
    // exitOverride must propagate to subcommands
    program.commands.forEach((cmd) => cmd.exitOverride());
    await expect(program.parseAsync(["node", "council", "doctor", "--unknown-flag"])).rejects.toThrow(
      /unknown option/,
    );
  });
});

describe("missing required argument help hint", () => {
  function captureErrorOutput(program: Command): { readonly output: string[] } {
    const output: string[] = [];
    program.exitOverride();
    program.configureOutput({
      writeOut: (str) => output.push(str),
      writeErr: (str) => output.push(str),
    });
    program.commands.forEach((cmd) => {
      cmd.exitOverride();
      cmd.configureOutput({
        writeOut: (str) => output.push(str),
        writeErr: (str) => output.push(str),
      });
    });
    return { output };
  }

  it("appends a --help hint when convene is missing the topic argument", async () => {
    const program = buildProgram();
    const { output } = captureErrorOutput(program);

    await expect(program.parseAsync(["node", "council", "convene"])).rejects.toThrow(
      /missing required argument/,
    );

    const combined = output.join("");
    expect(combined).toMatch(/missing required argument/);
    expect(combined).toMatch(/--help/);
  });

  it("does not interfere with the unknown-command suggestion behaviour", async () => {
    const program = buildProgram();
    const { output } = captureErrorOutput(program);

    await expect(program.parseAsync(["node", "council", "convne"])).rejects.toThrow();

    const combined = output.join("");
    expect(combined).toMatch(/unknown command/i);
    // Commander's "Did you mean ...?" suggestion must still appear
    expect(combined).toMatch(/did you mean/i);
  });
});
