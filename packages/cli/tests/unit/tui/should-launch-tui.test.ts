import { describe, expect, it } from "vitest";

import { shouldLaunchTui } from "../../../src/tui/lib/should-launch-tui.js";

/**
 * Exhaustive truth table for the launch gate after the 9.10 default-flip.
 *
 * Dimensions (the full input space of `shouldLaunchTui`):
 *   1. subcommand present?      — a non-flag positional in argv (e.g. `convene`)
 *   2. `--no-tui` flag present? — explicit per-invocation opt-out (a flag, NOT a subcommand)
 *   3. `stdout.isTTY`           — interactive terminal or piped/non-TTY
 *   4. `stdin.isTTY`            — interactive terminal or piped/non-TTY input
 *   5. `CI`                     — unset / empty / set
 *   6. `COUNCIL_NO_TUI`         — unset / empty / set (persistent opt-out)
 *   7. `COUNCIL_TUI`            — unset / empty / "1" (legacy opt-in force)
 *
 * The NEW default is ON: a bare `council` on an interactive TTY (not CI, no
 * opt-out) launches the TUI even when `COUNCIL_TUI` is unset. Every escape
 * hatch is preserved.
 */

const TTY = { isTTY: true } as const;
const NON_TTY = { isTTY: false } as const;

/** Interactive vs piped stdin — distinct from stdout so both can be swept. */
const STDIN_TTY = { isTTY: true } as const;
const STDIN_NON_TTY = { isTTY: false } as const;

/** Spec helper: an env var counts as "set" only when present and non-empty. */
function isEnvSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

interface LaunchInputs {
  readonly subcommand: string | null;
  readonly noTui: boolean;
  readonly isTTY: boolean;
  readonly stdinIsTTY: boolean;
  readonly ci: string | undefined;
  readonly councilNoTui: string | undefined;
  readonly councilTui: string | undefined;
}

/**
 * Specification oracle — a direct restatement of the 9.10 launch rules, in
 * precedence order. It deliberately does NOT read the implementation; the
 * cartesian sweep below asserts the implementation matches this spec for every
 * input combination, which both pins the new default and yields 100% branch
 * coverage of `shouldLaunchTui`.
 */
function expectedLaunch(inputs: LaunchInputs): boolean {
  if (inputs.noTui) return false; // explicit --no-tui opt-out wins first
  if (inputs.subcommand !== null) return false; // any subcommand routes to the CLI
  if (inputs.isTTY !== true) return false; // non-TTY stdout falls back to the CLI
  if (inputs.stdinIsTTY !== true) return false; // piped/non-TTY stdin falls back to the CLI
  if (isEnvSet(inputs.ci)) return false; // never auto-launch under CI
  if (isEnvSet(inputs.councilNoTui)) return false; // persistent opt-out
  return true; // default ON (COUNCIL_TUI=1 is now a redundant force)
}

function buildArgv(subcommand: string | null, noTui: boolean): readonly string[] {
  const argv = ["node", "council"];
  if (noTui) argv.push("--no-tui");
  if (subcommand !== null) argv.push(subcommand);
  return argv;
}

function buildEnv(inputs: LaunchInputs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (inputs.ci !== undefined) env["CI"] = inputs.ci;
  if (inputs.councilNoTui !== undefined) env["COUNCIL_NO_TUI"] = inputs.councilNoTui;
  if (inputs.councilTui !== undefined) env["COUNCIL_TUI"] = inputs.councilTui;
  return env;
}

describe("shouldLaunchTui", () => {
  describe("headline behaviors (the 9.10 default-flip)", () => {
    it("defaults ON for bare `council` on a TTY (COUNCIL_TUI unset)", () => {
      expect(shouldLaunchTui(["node", "council"], { stdout: TTY, stdin: STDIN_TTY, env: {} })).toBe(
        true,
      );
    });

    it("ignores leading global flags when detecting a bare invocation", () => {
      expect(
        shouldLaunchTui(["node", "council", "-q"], { stdout: TTY, stdin: STDIN_TTY, env: {} }),
      ).toBe(true);
    });

    it("returns false when `--no-tui` is present (it is a flag, not a subcommand)", () => {
      expect(
        shouldLaunchTui(["node", "council", "--no-tui"], {
          stdout: TTY,
          stdin: STDIN_TTY,
          env: {},
        }),
      ).toBe(false);
    });

    it("returns false when `--no-tui` is present even with COUNCIL_TUI=1", () => {
      expect(
        shouldLaunchTui(["node", "council", "--no-tui"], {
          stdout: TTY,
          stdin: STDIN_TTY,
          env: { COUNCIL_TUI: "1" },
        }),
      ).toBe(false);
    });

    it("returns false for any non-flag subcommand", () => {
      for (const sub of ["convene", "doctor", "chat", "panel"]) {
        expect(
          shouldLaunchTui(["node", "council", sub], { stdout: TTY, stdin: STDIN_TTY, env: {} }),
        ).toBe(false);
      }
    });

    it("returns false on a non-TTY / piped stdout", () => {
      expect(
        shouldLaunchTui(["node", "council"], { stdout: NON_TTY, stdin: STDIN_TTY, env: {} }),
      ).toBe(false);
    });

    it("returns false on a non-TTY / piped stdin even with a TTY stdout", () => {
      expect(
        shouldLaunchTui(["node", "council"], { stdout: TTY, stdin: STDIN_NON_TTY, env: {} }),
      ).toBe(false);
    });

    it("returns false when CI is set and non-empty", () => {
      expect(
        shouldLaunchTui(["node", "council"], {
          stdout: TTY,
          stdin: STDIN_TTY,
          env: { CI: "true" },
        }),
      ).toBe(false);
    });

    it("still defaults ON when CI is present but empty", () => {
      expect(
        shouldLaunchTui(["node", "council"], { stdout: TTY, stdin: STDIN_TTY, env: { CI: "" } }),
      ).toBe(true);
    });

    it("returns false when COUNCIL_NO_TUI is set and non-empty", () => {
      expect(
        shouldLaunchTui(["node", "council"], {
          stdout: TTY,
          stdin: STDIN_TTY,
          env: { COUNCIL_NO_TUI: "1" },
        }),
      ).toBe(false);
    });

    it("still defaults ON when COUNCIL_NO_TUI is present but empty", () => {
      expect(
        shouldLaunchTui(["node", "council"], {
          stdout: TTY,
          stdin: STDIN_TTY,
          env: { COUNCIL_NO_TUI: "" },
        }),
      ).toBe(true);
    });

    it("honors COUNCIL_TUI=1 as an explicit force on a bare TTY", () => {
      expect(
        shouldLaunchTui(["node", "council"], {
          stdout: TTY,
          stdin: STDIN_TTY,
          env: { COUNCIL_TUI: "1" },
        }),
      ).toBe(true);
    });

    it("keeps CI precedence over COUNCIL_TUI=1 (CI opt-out wins)", () => {
      expect(
        shouldLaunchTui(["node", "council"], {
          stdout: TTY,
          stdin: STDIN_TTY,
          env: { COUNCIL_TUI: "1", CI: "true" },
        }),
      ).toBe(false);
    });
  });

  describe("dependency-injection stream defaults", () => {
    it("falls back to the live process stdout/env when no streams are injected", () => {
      // With no `streams` argument, stdout/env default to the live process
      // values (the `?? process.stdout` / `?? process.env` seams). A subcommand
      // short-circuits to the CLI before either stream is inspected, so the
      // result is deterministic regardless of the runner's TTY/CI state.
      expect(shouldLaunchTui(["node", "council", "convene"])).toBe(false);
    });
  });

  describe("exhaustive cartesian sweep over every input dimension", () => {
    const subcommands: readonly (string | null)[] = [null, "convene", "doctor"];
    const noTuis: readonly boolean[] = [false, true];
    const ttys: readonly boolean[] = [true, false];
    const stdinTtys: readonly boolean[] = [true, false];
    const cis: readonly (string | undefined)[] = [undefined, "", "true"];
    const noTuiEnvs: readonly (string | undefined)[] = [undefined, "", "1"];
    const tuiEnvs: readonly (string | undefined)[] = [undefined, "", "1"];

    it("matches the specification oracle for all input combinations", () => {
      let combos = 0;
      for (const subcommand of subcommands) {
        for (const noTui of noTuis) {
          for (const isTTY of ttys) {
            for (const stdinIsTTY of stdinTtys) {
              for (const ci of cis) {
                for (const councilNoTui of noTuiEnvs) {
                  for (const councilTui of tuiEnvs) {
                    const inputs: LaunchInputs = {
                      subcommand,
                      noTui,
                      isTTY,
                      stdinIsTTY,
                      ci,
                      councilNoTui,
                      councilTui,
                    };
                    const argv = buildArgv(subcommand, noTui);
                    const actual = shouldLaunchTui(argv, {
                      stdout: { isTTY },
                      stdin: { isTTY: stdinIsTTY },
                      env: buildEnv(inputs),
                    });
                    const expected = expectedLaunch(inputs);
                    expect(
                      actual,
                      `argv=${JSON.stringify(argv)} isTTY=${isTTY} stdinIsTTY=${stdinIsTTY} ` +
                        `CI=${String(ci)} COUNCIL_NO_TUI=${String(councilNoTui)} ` +
                        `COUNCIL_TUI=${String(councilTui)}`,
                    ).toBe(expected);
                    combos += 1;
                  }
                }
              }
            }
          }
        }
      }
      // 3 subcommands × 2 noTui × 2 tty × 2 stdin × 3 CI × 3 NO_TUI × 3 TUI = 648
      expect(combos).toBe(648);
    });
  });
});
