// packages/cli/tests/unit/tui/interactive.test.ts
import { describe, expect, it } from "vitest";

import { isInteractive } from "../../../src/tui/lib/interactive.js";

describe("isInteractive", () => {
  it("is true for a TTY with no CI and no COUNCIL_NO_TUI", () => {
    expect(isInteractive({ stdout: { isTTY: true }, env: {} })).toBe(true);
  });

  it("is false when stdout is not a TTY", () => {
    expect(isInteractive({ stdout: { isTTY: false }, env: {} })).toBe(false);
  });

  it("is false when CI is set", () => {
    expect(isInteractive({ stdout: { isTTY: true }, env: { CI: "true" } })).toBe(false);
  });

  it("is false when COUNCIL_NO_TUI is set to any non-empty value", () => {
    expect(isInteractive({ stdout: { isTTY: true }, env: { COUNCIL_NO_TUI: "1" } })).toBe(false);
  });

  it("treats COUNCIL_NO_TUI='' (empty) as unset", () => {
    expect(isInteractive({ stdout: { isTTY: true }, env: { COUNCIL_NO_TUI: "" } })).toBe(true);
  });
});
