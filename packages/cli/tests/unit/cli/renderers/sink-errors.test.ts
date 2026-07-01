/**
 * Unit tests for the shared sink-error classifier.
 *
 * `isEpipe` is the single source of truth both the JSON and Plain renderers use
 * to decide whether a failed `sink.write` is a broken pipe (graceful shutdown
 * when `council … | head` closes the pipe) or a real error that must propagate.
 * Sharing the predicate guarantees the two renderers stay consistent (#85).
 *
 * RED at the test-only commit: `./sink-errors.js` does not exist yet.
 */
import { describe, expect, it } from "vitest";

import { isEpipe } from "../../../../src/cli/renderers/sink-errors.js";

describe("isEpipe", () => {
  it("returns true for an Error carrying code EPIPE", () => {
    expect(isEpipe(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe(true);
  });

  it("returns false for an Error with a different errno code", () => {
    expect(isEpipe(Object.assign(new Error("permission denied"), { code: "EACCES" }))).toBe(false);
  });

  it("returns false for an Error with no code", () => {
    expect(isEpipe(new Error("boom"))).toBe(false);
  });

  it("returns false for a non-Error value that merely carries code EPIPE", () => {
    expect(isEpipe({ code: "EPIPE" })).toBe(false);
  });

  it("returns false for nullish and primitive values", () => {
    expect(isEpipe(undefined)).toBe(false);
    expect(isEpipe(null)).toBe(false);
    expect(isEpipe("EPIPE")).toBe(false);
  });
});
