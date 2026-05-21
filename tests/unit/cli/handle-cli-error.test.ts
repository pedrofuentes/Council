import { describe, expect, it } from "vitest";

import { CliUserError } from "../../../src/cli/cli-user-error.js";
import { handleCliError } from "../../../src/cli/handle-cli-error.js";

describe("handleCliError", () => {
  it("returns exit code 1 for CliUserError without writing (already written)", () => {
    let stderr = "";
    const result = handleCliError(new CliUserError("Expert not found."), (s) => {
      stderr += s;
    });
    expect(result).toBe(1);
    expect(stderr).toBe("");
  });

  it("returns exit code 4 and writes message for plain Error (no stack trace)", () => {
    let stderr = "";
    const result = handleCliError(new Error("something broke"), (s) => {
      stderr += s;
    });
    expect(result).toBe(4);
    expect(stderr).toContain("something broke");
    expect(stderr).not.toContain("at "); // no stack trace lines
  });

  it("returns exit code 4 and writes message for non-Error values", () => {
    let stderr = "";
    const result = handleCliError("string error", (s) => {
      stderr += s;
    });
    expect(result).toBe(4);
    expect(stderr).toContain("string error");
  });

  it("handles PanelNotFoundError by writing user-friendly message", () => {
    // PanelNotFoundError is a plain Error subclass from template-loader
    const err = new Error('Panel template "ghost" not found in /panels');
    err.name = "PanelNotFoundError";
    let stderr = "";
    const result = handleCliError(err, (s) => {
      stderr += s;
    });
    expect(result).toBe(4);
    expect(stderr).toContain("ghost");
    expect(stderr).not.toContain("at "); // no stack trace
  });
});
