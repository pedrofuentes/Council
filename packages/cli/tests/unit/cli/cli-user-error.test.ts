import { describe, expect, it } from "vitest";

import { CliUserError } from "../../../src/cli/cli-user-error.js";

describe("CliUserError", () => {
  it("extends Error", () => {
    const err = new CliUserError("something went wrong");
    expect(err).toBeInstanceOf(Error);
  });

  it("is detectable via instanceof", () => {
    const err: Error = new CliUserError("not found");
    expect(err instanceof CliUserError).toBe(true);
  });

  it("preserves the message", () => {
    const err = new CliUserError("Expert \"ghost\" not found.");
    expect(err.message).toBe('Expert "ghost" not found.');
  });

  it("has the correct name", () => {
    const err = new CliUserError("oops");
    expect(err.name).toBe("CliUserError");
  });

  it("is distinguishable from a plain Error", () => {
    const plain = new Error("plain");
    expect(plain instanceof CliUserError).toBe(false);
  });
});
