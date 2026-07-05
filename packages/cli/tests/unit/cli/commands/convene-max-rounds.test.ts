/**
 * RED — the convene CLI path must honor a panel template's declared
 * `maxRounds`, matching the TUI convene resolver
 * (`tui/adapters/convene-resolve.ts`, which resolves
 * `panel.defaults?.maxRounds ?? config.defaults.maxRounds`). The CLI adds an
 * explicit `--max-rounds` flag on top, so the precedence is
 * flag > template default > config default.
 *
 * This unit test pins the pure `resolveMaxRounds` helper that encodes that
 * precedence; the e2e suite (`tests/e2e/convene-max-rounds.test.ts`) verifies
 * the command actually runs the resolved number of rounds.
 */
import { describe, expect, it } from "vitest";

import { resolveMaxRounds } from "../../../../src/cli/commands/convene.js";

describe("convene — resolveMaxRounds precedence", () => {
  it("uses the explicit --max-rounds flag over the template and config defaults", () => {
    expect(resolveMaxRounds(2, 3, 4)).toBe(2);
  });

  it("uses the template's declared maxRounds when no flag is given", () => {
    expect(resolveMaxRounds(undefined, 3, 4)).toBe(3);
  });

  it("falls back to the config default when neither flag nor template declares maxRounds", () => {
    // A distinctive config value (6) proves the fallback targets the config
    // default rather than any hardcoded convene constant.
    expect(resolveMaxRounds(undefined, undefined, 6)).toBe(6);
  });

  it("keeps an explicit flag even when it coincides with the config default", () => {
    // An explicit flag must win even when it equals the config default — the
    // resolver never silently swaps a real flag for a default.
    expect(resolveMaxRounds(4, 3, 4)).toBe(4);
  });
});
