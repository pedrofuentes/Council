import { Command } from "commander";

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
});
