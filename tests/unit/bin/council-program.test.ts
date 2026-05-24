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
