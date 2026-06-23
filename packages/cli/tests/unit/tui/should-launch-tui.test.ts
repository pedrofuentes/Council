import { describe, expect, it } from "vitest";

import { shouldLaunchTui } from "../../../src/tui/lib/should-launch-tui.js";

const tty = { isTTY: true };
const base = (env: NodeJS.ProcessEnv) => ({ stdout: tty, env });

describe("shouldLaunchTui", () => {
  it("is true for bare `council` on a TTY with COUNCIL_TUI=1", () => {
    expect(shouldLaunchTui(["node", "council"], base({ COUNCIL_TUI: "1" }))).toBe(true);
  });
  it("is false when a subcommand is present", () => {
    expect(shouldLaunchTui(["node", "council", "convene"], base({ COUNCIL_TUI: "1" }))).toBe(false);
  });
  it("ignores global flags when detecting a bare invocation", () => {
    expect(shouldLaunchTui(["node", "council", "-q"], base({ COUNCIL_TUI: "1" }))).toBe(true);
  });
  it("is false without COUNCIL_TUI=1", () => {
    expect(shouldLaunchTui(["node", "council"], base({}))).toBe(false);
  });
  it("is false when not a TTY", () => {
    expect(shouldLaunchTui(["node", "council"], { stdout: { isTTY: false }, env: { COUNCIL_TUI: "1" } })).toBe(false);
  });
  it("is false under CI or COUNCIL_NO_TUI", () => {
    expect(shouldLaunchTui(["node", "council"], base({ COUNCIL_TUI: "1", CI: "true" }))).toBe(false);
    expect(shouldLaunchTui(["node", "council"], base({ COUNCIL_TUI: "1", COUNCIL_NO_TUI: "1" }))).toBe(false);
  });
});
