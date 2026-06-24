import { describe, expect, it } from "vitest";

import {
  selectStartupWarnings,
  type StartupWarning,
} from "../../../src/tui/lib/startup-warnings.js";

describe("selectStartupWarnings", () => {
  it("combines sanitized config warnings then the update notice, in order", () => {
    const result = selectStartupWarnings({
      warnings: ["config key deprecated", "model\u001b[31m fallback\u2028used"],
      updateNotice: "\u001b[33mUpdate available\u001b[39m 1.0.0 \u2192 2.0.0\n",
    });

    // Config warnings precede the update notice; every string is collapsed to a
    // single sanitized line (ANSI stripped, U+2028/newline collapsed to a space).
    expect(result).toEqual<readonly StartupWarning[]>([
      { kind: "warning", text: "config key deprecated" },
      { kind: "warning", text: "model fallback used" },
      { kind: "update", text: "Update available 1.0.0 \u2192 2.0.0" },
    ]);
  });

  it("drops warnings that are blank once sanitized (length guard bites)", () => {
    const result = selectStartupWarnings({
      warnings: ["   ", "\u001b[2K", "real warning"],
    });

    // Whitespace-only and pure-control-sequence entries collapse to "" and must
    // be filtered, leaving only the meaningful warning.
    expect(result).toEqual<readonly StartupWarning[]>([{ kind: "warning", text: "real warning" }]);
  });

  it("omits the update notice when it is blank after sanitizing (update length guard bites)", () => {
    const result = selectStartupWarnings({
      warnings: ["keep me"],
      updateNotice: "  \u001b[2K\n  ",
    });

    expect(result).toEqual<readonly StartupWarning[]>([{ kind: "warning", text: "keep me" }]);
  });

  it("returns an empty list when neither warnings nor an update notice are provided", () => {
    expect(selectStartupWarnings({})).toEqual([]);
  });
});
