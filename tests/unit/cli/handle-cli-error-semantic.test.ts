/**
 * Tests for semantic exit codes in `handleCliError` and `CliUserError.exitCode`.
 *
 * RED at this commit: CliUserError doesn't have exitCode field,
 * handleCliError doesn't use semantic codes.
 */
import { describe, expect, it } from "vitest";

import { CliUserError } from "../../../src/cli/cli-user-error.js";
import { handleCliError } from "../../../src/cli/handle-cli-error.js";
import { EXIT_AUTH_ERROR, EXIT_INTERNAL_ERROR, EXIT_USER_ERROR } from "../../../src/cli/exit-codes.js";

describe("handleCliError — semantic exit codes", () => {
  it("returns CliUserError.exitCode when present", () => {
    const err = new CliUserError("auth failed");
    err.exitCode = EXIT_AUTH_ERROR;
    let _stderr = "";
    const result = handleCliError(err, (s) => {
      _stderr += s;
    });
    expect(result).toBe(EXIT_AUTH_ERROR);
  });

  it("defaults to EXIT_USER_ERROR (1) for CliUserError without exitCode", () => {
    const err = new CliUserError("bad input");
    let _stderr = "";
    const result = handleCliError(err, (s) => {
      _stderr += s;
    });
    expect(result).toBe(EXIT_USER_ERROR);
  });

  it("returns EXIT_INTERNAL_ERROR (4) for unknown Error types", () => {
    let _stderr = "";
    const result = handleCliError(new Error("boom"), (s) => {
      _stderr += s;
    });
    expect(result).toBe(EXIT_INTERNAL_ERROR);
  });

  it("returns EXIT_INTERNAL_ERROR (4) for non-Error values", () => {
    let _stderr = "";
    const result = handleCliError("string error", (s) => {
      _stderr += s;
    });
    expect(result).toBe(EXIT_INTERNAL_ERROR);
  });
});

describe("CliUserError.exitCode field", () => {
  it("defaults to undefined", () => {
    const err = new CliUserError("test");
    expect(err.exitCode).toBeUndefined();
  });

  it("can be set after construction", () => {
    const err = new CliUserError("test");
    err.exitCode = 3;
    expect(err.exitCode).toBe(3);
  });
});

describe("handleCliError — engine error code propagation", () => {
  it("maps NOT_AUTHENTICATED Error to EXIT_AUTH_ERROR (2)", () => {
    const err = Object.assign(new Error("auth required"), { code: "NOT_AUTHENTICATED" });
    let _stderr = "";
    const result = handleCliError(err, (s) => {
      _stderr += s;
    });
    expect(result).toBe(EXIT_AUTH_ERROR);
  });

  it("maps NETWORK Error to EXIT_NETWORK_ERROR (3)", () => {
    const err = Object.assign(new Error("timeout"), { code: "NETWORK" });
    let _stderr = "";
    const result = handleCliError(err, (s) => {
      _stderr += s;
    });
    expect(result).toBe(3);
  });
});
